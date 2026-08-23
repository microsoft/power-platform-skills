#!/usr/bin/env node
'use strict';

/**
 * Deduplicates planned native capabilities into independently-owned batches and
 * verifies the joined wrapper surface after all batches finish.
 *
 * Usage:
 *   node plan-native-batches.js <project-dir> plan
 *   node plan-native-batches.js <project-dir> check
 *   node plan-native-batches.js <project-dir> verify
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  hashFile,
  readJson,
  sha256,
  stableJson,
  writeJsonAtomic,
} = require('./lib/workflow-artifacts');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

const GROUPS = {
  camera: 'camera-suite',
  'take-photo': 'camera-suite',
  'image-picker': 'camera-suite',
  'barcode-scanner': 'camera-suite',
  'qr-scanner': 'camera-suite',
  'pdf-report': 'pdf-report',
  'pdf-viewer': 'pdf-viewer',
  'pen-input': 'pen-input',
  geolocation: 'geolocation',
};

function fail(message) {
  console.error(`native-batches: ${message}`);
  process.exit(1);
}

function normalizeCapability(value) {
  return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function safeWrapper(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!/^src\/native\/[A-Za-z0-9_./\[\]-]+\.tsx?$/.test(normalized) || normalized.includes('../')) {
    fail(`unsafe wrapper path: ${normalized}`);
  }
  return normalized;
}

function load(projectRoot) {
  const contractPath = path.join(projectRoot, '.tmp', 'native-capabilities-contract.json');
  const contract = readJson(contractPath, '.tmp/native-capabilities-contract.json');
  if (contract.schemaVersion !== 1 || !Array.isArray(contract.capabilities)) {
    fail('native capability contract must have schemaVersion 1 and a capabilities array');
  }
  const projectPackage = readJson(path.join(projectRoot, 'package.json'), 'package.json');
  const templatePackage = readJson(path.join(PLUGIN_ROOT, 'template', 'package.json'), 'template/package.json');
  const projectDeps = { ...projectPackage.dependencies, ...projectPackage.devDependencies };
  const templateDeps = { ...templatePackage.dependencies, ...templatePackage.devDependencies };
  const groups = new Map();

  for (const row of contract.capabilities) {
    const capability = normalizeCapability(row.capability);
    if (!capability) fail('capability name is required');
    const packageName = String(row.package || '').trim();
    if (!packageName) fail(`capability ${capability} requires an exact package`);
    if (!projectDeps[packageName] || !templateDeps[packageName]) {
      fail(`capability ${capability} package is not shipped by both project and template: ${packageName}`);
    }
    if (projectDeps[packageName] !== templateDeps[packageName]) {
      fail(`capability ${capability} package version differs from the template: ${packageName}`);
    }
    const group = String(row.group || GROUPS[capability] || capability);
    if (!groups.has(group)) {
      groups.set(group, {
        id: group,
        capabilities: [],
        packages: [],
        wrapperFiles: [],
      });
    }
    const target = groups.get(group);
    target.capabilities.push(capability);
    target.packages.push({ name: packageName, version: projectDeps[packageName] });
    for (const wrapper of row.wrapperFiles || []) target.wrapperFiles.push(safeWrapper(wrapper));
  }

  const batches = [...groups.values()].map((group) => ({
    ...group,
    capabilities: [...new Set(group.capabilities)].sort(),
    packages: [...new Map(group.packages.map((item) => [item.name, item])).values()]
      .sort((left, right) => left.name.localeCompare(right.name)),
    wrapperFiles: [...new Set(group.wrapperFiles)].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id));

  return {
    schemaVersion: 1,
    contractSha256: hashFile(contractPath),
    batches,
    batchesSha256: sha256(stableJson(batches)),
  };
}

function plan(projectRoot) {
  const output = load(projectRoot);
  writeJsonAtomic(path.join(projectRoot, '.tmp', 'native-batches.json'), {
    ...output,
    generatedAt: new Date().toISOString(),
  });
  console.log(`native-batches: planned ${output.batches.length} independent batches`);
}

function check(projectRoot) {
  const plannedPath = path.join(projectRoot, '.tmp', 'native-batches.json');
  if (!fs.existsSync(plannedPath)) fail('.tmp/native-batches.json is missing');
  const planned = readJson(plannedPath, '.tmp/native-batches.json');
  const current = load(projectRoot);
  if (planned.contractSha256 !== current.contractSha256 || planned.batchesSha256 !== current.batchesSha256) {
    fail('native batch plan is stale');
  }
  console.log(`native-batches: valid (${current.batches.length} batches)`);
}

function verify(projectRoot) {
  const plannedPath = path.join(projectRoot, '.tmp', 'native-batches.json');
  const planned = readJson(plannedPath, '.tmp/native-batches.json');
  const current = load(projectRoot);
  if (planned.contractSha256 !== current.contractSha256 || planned.batchesSha256 !== current.batchesSha256) {
    fail('native batch plan is stale');
  }
  const wrappers = [];
  for (const batch of current.batches) {
    for (const relativePath of batch.wrapperFiles) {
      const filePath = path.join(projectRoot, relativePath);
      if (!fs.existsSync(filePath)) fail(`native join gate missing wrapper: ${relativePath}`);
      wrappers.push({ path: relativePath, sha256: hashFile(filePath) });
    }
  }
  const receipt = {
    schemaVersion: 1,
    contractSha256: current.contractSha256,
    batchesSha256: current.batchesSha256,
    wrappers: wrappers.sort((left, right) => left.path.localeCompare(right.path)),
    verifiedAt: new Date().toISOString(),
  };
  receipt.receiptSha256 = sha256(stableJson(receipt));
  writeJsonAtomic(path.join(projectRoot, '.tmp', 'native-bundle-validation.json'), receipt);
  console.log(`native-batches: verified ${wrappers.length} wrappers`);
}

function main() {
  const projectArg = process.argv[2];
  const action = process.argv[3];
  if (!projectArg || !['plan', 'check', 'verify'].includes(action)) {
    fail('usage: node plan-native-batches.js <project-dir> <plan|check|verify>');
  }
  const projectRoot = path.resolve(projectArg);
  if (action === 'plan') plan(projectRoot);
  else if (action === 'check') check(projectRoot);
  else verify(projectRoot);
}

main();
