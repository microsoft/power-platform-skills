#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { arithmeticContract, expectedTotal } = require('./lib/seed-consistency');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateProject(projectDir) {
  const root = path.resolve(projectDir);
  const contractPath = path.join(root, '.tmp', 'dataverse-schema-contract.json');
  const manifestPath = path.join(root, 'src', 'generated', '.prototype-manifest.json');
  if (!fs.existsSync(contractPath)) throw new Error('.tmp/dataverse-schema-contract.json is required');
  if (!fs.existsSync(manifestPath)) throw new Error('src/generated/.prototype-manifest.json is required');
  const schema = readJson(contractPath);
  const manifest = readJson(manifestPath);
  const seedFiles = new Map((manifest.tableSchemas || []).map((table) => [table.logicalName, table.seedFile]));
  const findings = [];
  let checkedRows = 0;
  let checkedTables = 0;

  for (const table of schema.tables || []) {
    const arithmetic = arithmeticContract(table);
    if (!arithmetic) continue;
    const logicalName = String(table.logicalName || '');
    const seedFile = seedFiles.get(logicalName);
    if (!seedFile) {
      findings.push(`${logicalName}: generated seed file is absent from the prototype manifest`);
      continue;
    }
    const seedPath = path.join(root, seedFile);
    if (!fs.existsSync(seedPath)) {
      findings.push(`${logicalName}: seed file does not exist: ${seedFile}`);
      continue;
    }
    const rows = readJson(seedPath);
    if (!Array.isArray(rows)) {
      findings.push(`${logicalName}: ${seedFile} must contain an array`);
      continue;
    }
    checkedTables += 1;
    for (const [index, row] of rows.entries()) {
      if (!Number.isFinite(row?.[arithmetic.quantity]) || !Number.isFinite(row?.[arithmetic.unitPrice])) {
        findings.push(`${logicalName}[${index}]: ${arithmetic.quantity} and ${arithmetic.unitPrice} must be finite numbers`);
        continue;
      }
      checkedRows += 1;
      const expected = expectedTotal(row[arithmetic.quantity], row[arithmetic.unitPrice]);
      for (const total of arithmetic.totals) {
        if (!Number.isFinite(row?.[total]) || Math.abs(row[total] - expected) > 0.001) {
          findings.push(`${logicalName}[${index}].${total} is ${JSON.stringify(row?.[total])}, expected ${expected} from ${arithmetic.quantity} * ${arithmetic.unitPrice}`);
        }
      }
    }
  }

  return { valid: findings.length === 0, findings, checkedTables, checkedRows };
}

function main() {
  const projectDir = process.argv[2];
  if (!projectDir) throw new Error('usage: node validate-seed-consistency.js <project-dir>');
  const result = validateProject(projectDir);
  if (!result.valid) {
    for (const finding of result.findings) console.error(`seed-consistency: ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(`seed-consistency: PASS (${result.checkedRows} rows across ${result.checkedTables} arithmetic table(s))`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`seed-consistency: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main, validateProject };