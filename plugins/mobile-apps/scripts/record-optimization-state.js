#!/usr/bin/env node
'use strict';

/**
 * Atomically records successful plan/manifest and optimization receipt hashes
 * in .mobile-app/state.json.
 *
 * Usage:
 *   node record-optimization-state.js <project-dir>
 *     [--data-mode prototype|dataverse] [--clear-transition]
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

const RECEIPTS = {
  templatePrep: '.tmp/template-prep-receipt.json',
  screenContract: '.tmp/screen-contract.json',
  serviceInventory: '.tmp/service-inventory.json',
  designDecision: 'brand/design-decision.json',
  nativeBundleValidation: '.tmp/native-bundle-validation.json',
  screenWaves: '.tmp/screen-waves.json',
  tscCacheManifest: '.tmp/tsc-cache-manifest.json',
  validation: '.tmp/validation-receipt.json',
  finalChecks: '.tmp/final-checks-receipt.json',
  previewLock: '.tmp/preview-lock.json',
};

function fail(message) {
  console.error(`optimization-state: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { clearTransition: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--data-mode') parsed.dataMode = argv[++index];
    else if (argv[index] === '--clear-transition') parsed.clearTransition = true;
  }
  return parsed;
}

function hashOptional(projectRoot, relativePath) {
  const filePath = path.join(projectRoot, relativePath);
  return fs.existsSync(filePath) ? hashFile(filePath) : null;
}

function main() {
  const projectArg = process.argv[2];
  if (!projectArg) fail('usage: node record-optimization-state.js <project-dir> [--data-mode prototype|dataverse] [--clear-transition]');
  const args = parseArgs(process.argv.slice(3));
  if (args.dataMode && !['prototype', 'dataverse'].includes(args.dataMode)) {
    fail('--data-mode must be prototype or dataverse');
  }
  const projectRoot = path.resolve(projectArg);
  const statePath = path.join(projectRoot, '.mobile-app', 'state.json');
  const existing = fs.existsSync(statePath)
    ? readJson(statePath, '.mobile-app/state.json')
    : {
      schemaVersion: 1,
      dataMode: args.dataMode || null,
      environment: null,
      transition: null,
      lastSyncedPlanHash: null,
      lastDataverseManifestHash: null,
      lastSyncAt: null,
    };
  if (existing.schemaVersion !== 1) fail('unsupported lifecycle state schemaVersion');
  const dataMode = args.dataMode || existing.dataMode;
  if (!['prototype', 'dataverse'].includes(dataMode)) fail('data mode is missing or unsupported');
  const planPath = path.join(projectRoot, 'native-app-plan.md');
  if (!fs.existsSync(planPath)) fail('native-app-plan.md is missing');
  const finalReceiptPath = path.join(projectRoot, '.tmp', 'final-checks-receipt.json');
  if (!fs.existsSync(finalReceiptPath)) fail('.tmp/final-checks-receipt.json is missing');
  const finalReceipt = readJson(finalReceiptPath, '.tmp/final-checks-receipt.json');
  if (finalReceipt.status !== 'pass') fail('final-checks receipt is not PASS');
  const finalReceiptIntegrity = finalReceipt.receiptSha256;
  const finalReceiptWithoutIntegrity = { ...finalReceipt };
  delete finalReceiptWithoutIntegrity.receiptSha256;
  if (finalReceiptIntegrity !== sha256(stableJson(finalReceiptWithoutIntegrity))) {
    fail('final-checks receipt integrity hash is invalid');
  }

  const optimizationReceipts = Object.fromEntries(
    Object.entries(RECEIPTS).map(([key, relativePath]) => [key, hashOptional(projectRoot, relativePath)]),
  );
  const state = {
    ...existing,
    schemaVersion: 1,
    dataMode,
    transition: args.clearTransition ? null : existing.transition,
    lastSyncedPlanHash: hashFile(planPath),
    lastDataverseManifestHash: dataMode === 'dataverse'
      ? hashOptional(projectRoot, '.datamodel-manifest.json')
      : null,
    optimizationReceipts,
    lastSyncAt: new Date().toISOString(),
  };
  if (dataMode === 'dataverse' && !state.lastDataverseManifestHash) {
    fail('Dataverse mode requires .datamodel-manifest.json');
  }
  writeJsonAtomic(statePath, state);
  console.log(`optimization-state: recorded ${dataMode} state`);
}

main();
