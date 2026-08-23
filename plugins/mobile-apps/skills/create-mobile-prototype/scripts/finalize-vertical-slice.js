#!/usr/bin/env node
'use strict';

/**
 * Validate and persist the delivery contract for a vertical-slice prototype.
 *
 * Usage:
 *   node finalize-vertical-slice.js <project-dir> check
 *   node finalize-vertical-slice.js <project-dir> finalize
 *   node finalize-vertical-slice.js <project-dir> expand
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_VALIDATION_MARKERS = [
  'check-routes.js',
  'validate-screen-contracts.js',
  'validate-screen-quality.js',
  'validate-color-contrast.js',
  'npm run type-check',
  'validate-mobile-files.js',
];

function fail(message) {
  console.error(`vertical-slice: ${message}`);
  process.exit(1);
}

function readText(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readText(filePath, label));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    fail(`${label} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function screenArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((screen, index) => {
    if (!screen || typeof screen !== 'object') fail(`${label}[${index}] must be an object`);
    for (const field of ['name', 'route', 'file']) {
      if (typeof screen[field] !== 'string' || !screen[field].trim()) {
        fail(`${label}[${index}].${field} must be a non-empty string`);
      }
    }
    return {
      name: screen.name.trim(),
      route: screen.route.trim(),
      file: screen.file.trim(),
    };
  });
}

function assertUnique(values, label) {
  const normalized = values.map((value) => value.toLowerCase());
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicates`);
}

function assertDisjoint(included, deferred, label) {
  const includedSet = new Set(included.map((value) => value.toLowerCase()));
  const overlap = deferred.find((value) => includedSet.has(value.toLowerCase()));
  if (overlap) fail(`${label} appears in both included and deferred scope: ${overlap}`);
}

function normalizedSet(values) {
  return [...new Set(values.map((value) => value.toLowerCase()))].sort();
}

function setsEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function emptyDeferredScope() {
  return {
    requirements: [],
    screens: [],
    entities: [],
    nativeCapabilities: [],
    connectors: [],
  };
}

function validateContract(projectDir, contract) {
  if (!contract || contract.schemaVersion !== 1) fail('slice contract schemaVersion must be 1');
  if (contract.deliveryMode !== 'vertical-slice') fail('slice contract deliveryMode must be vertical-slice');
  if (typeof contract.sliceGoal !== 'string' || !contract.sliceGoal.trim()) {
    fail('slice contract sliceGoal must be a non-empty string');
  }

  const acceptanceJourney = stringArray(contract.acceptanceJourney, 'acceptanceJourney');
  if (acceptanceJourney.length < 2) fail('acceptanceJourney must contain at least two observable steps');

  if (!contract.included || typeof contract.included !== 'object') fail('included scope is required');
  const screens = screenArray(contract.included.screens, 'included.screens');
  if (screens.length < 3 || screens.length > 6) {
    fail('included.screens must contain 3-6 user-visible business screens');
  }
  const baselineScreens = screenArray(contract.included.baselineScreens || [], 'included.baselineScreens');
  const entityLogicalNames = stringArray(contract.included.entityLogicalNames, 'included.entityLogicalNames');
  const nativeCapabilities = stringArray(contract.included.nativeCapabilities || [], 'included.nativeCapabilities');
  const connectors = stringArray(contract.included.connectors || [], 'included.connectors');

  assertUnique([...screens, ...baselineScreens].map((screen) => screen.file), 'included screen files');
  assertUnique([...screens, ...baselineScreens].map((screen) => screen.route), 'included screen routes');
  assertUnique(entityLogicalNames, 'included.entityLogicalNames');
  assertUnique(nativeCapabilities, 'included.nativeCapabilities');
  assertUnique(connectors, 'included.connectors');

  if (!contract.deferred || typeof contract.deferred !== 'object') fail('deferred scope is required');
  const deferred = {
    requirements: stringArray(contract.deferred.requirements || [], 'deferred.requirements'),
    screens: stringArray(contract.deferred.screens || [], 'deferred.screens'),
    entities: stringArray(contract.deferred.entities || [], 'deferred.entities'),
    nativeCapabilities: stringArray(contract.deferred.nativeCapabilities || [], 'deferred.nativeCapabilities'),
    connectors: stringArray(contract.deferred.connectors || [], 'deferred.connectors'),
  };
  const deferredCount = Object.values(deferred).reduce((count, values) => count + values.length, 0);
  if (deferredCount === 0) fail('vertical-slice mode requires at least one explicitly deferred item; use full mode otherwise');
  assertDisjoint(screens.map((screen) => screen.name), deferred.screens, 'screen');
  assertDisjoint(entityLogicalNames, deferred.entities, 'entity');
  assertDisjoint(nativeCapabilities, deferred.nativeCapabilities, 'native capability');
  assertDisjoint(connectors, deferred.connectors, 'connector');

  const planPath = path.join(projectDir, 'native-app-plan.md');
  const planText = readText(planPath, 'native-app-plan.md');
  for (const screen of [...screens, ...baselineScreens]) {
    if (!planText.includes(screen.file) || !planText.includes(screen.route)) {
      fail(`planned screen ${screen.name} is missing its route or file from native-app-plan.md`);
    }
  }

  const schemaPath = path.join(projectDir, '.tmp', 'dataverse-schema-contract.json');
  const schema = readJson(schemaPath, '.tmp/dataverse-schema-contract.json');
  if (schema.planningMode !== 'prototype' || schema.executionEligible !== false) {
    fail('prototype schema contract must remain planningMode=prototype and executionEligible=false');
  }
  const serviceTables = (schema.tables || [])
    .filter((table) => table && table.serviceRequired !== false
      && String(table.plannedDecision || table.decision || '').toLowerCase() !== 'defer')
    .map((table) => String(table.logicalName || ''))
    .filter(Boolean);
  if (!setsEqual(normalizedSet(serviceTables), normalizedSet(entityLogicalNames))) {
    fail('included.entityLogicalNames must exactly match service-required tables in the prototype schema contract');
  }

  return {
    schemaVersion: 1,
    deliveryMode: 'vertical-slice',
    sliceGoal: contract.sliceGoal.trim(),
    acceptanceJourney,
    included: {
      screens,
      baselineScreens,
      entityLogicalNames,
      nativeCapabilities,
      connectors,
    },
    deferred,
  };
}

function verifyApprovedPlan(projectDir, planBytes) {
  const receiptPath = path.join(projectDir, '.tmp', 'mobile-plan-status.json');
  const receipt = readJson(receiptPath, '.tmp/mobile-plan-status.json');
  const planHash = sha256(planBytes);
  if (receipt.approvedPlanSha256 !== planHash) {
    fail('mobile plan approval receipt does not match the current native-app-plan.md');
  }
  return planHash;
}

function verifySyncedPlan(projectDir, planBytes) {
  const statePath = path.join(projectDir, '.mobile-app', 'state.json');
  const state = readJson(statePath, '.mobile-app/state.json');
  const planHash = sha256(planBytes);
  if (state.lastSyncedPlanHash !== planHash) {
    fail('lifecycle lastSyncedPlanHash does not match the current native-app-plan.md');
  }
  return planHash;
}

function verifyFinalValidation(projectDir, planHash) {
  const relativePath = '.tmp/final-validation.md';
  const report = readText(path.join(projectDir, relativePath), relativePath);
  if (!/^Overall:\s*PASS\s*$/im.test(report)) fail('final validation report must contain `Overall: PASS`');
  if (!report.includes(planHash)) fail('final validation report does not match the current native-app-plan.md');
  for (const marker of REQUIRED_VALIDATION_MARKERS) {
    if (!report.includes(marker)) fail(`final validation report is missing ${marker}`);
  }
  return relativePath;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function main() {
  const projectArg = process.argv[2];
  const action = process.argv[3];
  if (!projectArg || !['check', 'finalize', 'expand'].includes(action)) {
    fail('usage: node finalize-vertical-slice.js <project-dir> <check|finalize|expand>');
  }

  const projectDir = path.resolve(projectArg);
  const temporaryContractPath = path.join(projectDir, '.tmp', 'vertical-slice-contract.json');
  const durableReceiptPath = path.join(projectDir, '.mobile-app', 'vertical-slice.json');

  if (action === 'check') {
    const contract = validateContract(
      projectDir,
      readJson(temporaryContractPath, '.tmp/vertical-slice-contract.json'),
    );
    console.log(`vertical-slice: valid (${contract.included.screens.length} business screens, ${contract.deferred.requirements.length + contract.deferred.screens.length + contract.deferred.entities.length + contract.deferred.nativeCapabilities.length + contract.deferred.connectors.length} deferred items)`);
    return;
  }

  const planBytes = Buffer.from(readText(path.join(projectDir, 'native-app-plan.md'), 'native-app-plan.md'));
  const approvedPlanSha256 = action === 'finalize'
    ? verifyApprovedPlan(projectDir, planBytes)
    : verifySyncedPlan(projectDir, planBytes);
  const validationReport = verifyFinalValidation(projectDir, approvedPlanSha256);
  const now = new Date().toISOString();

  if (action === 'finalize') {
    const contract = validateContract(
      projectDir,
      readJson(temporaryContractPath, '.tmp/vertical-slice-contract.json'),
    );
    writeJsonAtomic(durableReceiptPath, {
      ...contract,
      status: 'validated',
      approvedPlanSha256,
      validatedAt: now,
      validationReport,
    });
    console.log(`vertical-slice: finalized ${path.relative(projectDir, durableReceiptPath)}`);
    return;
  }

  const receipt = readJson(durableReceiptPath, '.mobile-app/vertical-slice.json');
  if (receipt.status !== 'validated') fail('only a validated vertical slice can be marked expanded');
  writeJsonAtomic(durableReceiptPath, {
    ...receipt,
    status: 'expanded',
    initialApprovedPlanSha256: receipt.initialApprovedPlanSha256 || receipt.approvedPlanSha256,
    approvedPlanSha256,
    expandedScope: receipt.deferred,
    deferred: emptyDeferredScope(),
    expandedAt: now,
    validationReport,
  });
  console.log(`vertical-slice: expanded ${path.relative(projectDir, durableReceiptPath)}`);
}

main();
