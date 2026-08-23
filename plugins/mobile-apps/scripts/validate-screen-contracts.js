#!/usr/bin/env node
'use strict';

/**
 * Validates that the approved structured screen contract matches the plan,
 * route files, service inventory, and screen data-access boundaries.
 *
 * Usage: node validate-screen-contracts.js [native-app-plan.md]
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

function fail(message) {
  console.error(`validate-screen-contracts: ${message}`);
  process.exit(1);
}

function main() {
  const planArg = process.argv[2] || 'native-app-plan.md';
  const planPath = path.resolve(planArg);
  const projectRoot = path.dirname(planPath);
  const contractPath = path.join(projectRoot, '.tmp', 'screen-contract.json');
  const inventoryPath = path.join(projectRoot, '.tmp', 'service-inventory.json');
  if (!fs.existsSync(planPath)) fail(`plan not found: ${planPath}`);
  if (!fs.existsSync(contractPath)) fail('.tmp/screen-contract.json is missing');
  if (!fs.existsSync(inventoryPath)) fail('.tmp/service-inventory.json is missing');
  const contract = readJson(contractPath, contractPath);
  const inventory = readJson(inventoryPath, inventoryPath);
  const planSha256 = hashFile(planPath);
  if (contract.approvedPlanSha256 !== planSha256) fail('screen contract plan hash is stale');
  const services = new Set((inventory.services || []).map((service) => service.name));
  const findings = [];

  for (const screen of contract.screens || []) {
    const filePath = path.join(projectRoot, screen.file);
    if (!fs.existsSync(filePath)) {
      findings.push({ screen: screen.id, rule: 'missing-screen-file', file: screen.file });
      continue;
    }
    const source = fs.readFileSync(filePath, 'utf8');
    if (/\.seed\.json['"]/.test(source)) findings.push({ screen: screen.id, rule: 'seed-import', file: screen.file });
    if (/\b(?:fetch|axios)\s*\(/.test(source)) findings.push({ screen: screen.id, rule: 'raw-http', file: screen.file });
    for (const serviceName of screen.services || []) {
      if (!services.has(serviceName)) findings.push({ screen: screen.id, rule: 'missing-service', service: serviceName });
      if (!source.includes(serviceName)) findings.push({ screen: screen.id, rule: 'declared-service-not-imported', service: serviceName });
    }
    for (const capability of screen.nativeCapabilities || []) {
      if (!source.includes('@/native/')) findings.push({ screen: screen.id, rule: 'native-wrapper-not-imported', capability });
    }
  }

  const receipt = {
    schemaVersion: 1,
    approvedPlanSha256: planSha256,
    screenContractSha256: hashFile(contractPath),
    serviceInventorySha256: hashFile(inventoryPath),
    status: findings.length ? 'fail' : 'pass',
    findings,
    checkedAt: new Date().toISOString(),
  };
  receipt.receiptSha256 = sha256(stableJson(receipt));
  writeJsonAtomic(path.join(projectRoot, '.tmp', 'screen-contract-validation.json'), receipt);
  if (findings.length) {
    for (const finding of findings) process.stderr.write(`${finding.screen}: ${finding.rule} ${finding.file || finding.service || finding.capability || ''}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`validate-screen-contracts: PASS (${(contract.screens || []).length} screens)`);
}

main();
