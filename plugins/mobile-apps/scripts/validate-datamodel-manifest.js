#!/usr/bin/env node
'use strict';

/**
 * Validate the project-local Dataverse manifest used by screen binding,
 * prototype conversion, sample-data migration, and offline reconciliation.
 *
 * Usage:
 *   node scripts/validate-datamodel-manifest.js <manifest-path> [--json]
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const manifestArg = args.find((arg) => !arg.startsWith('--'));

if (!manifestArg) {
  console.error('Usage: node scripts/validate-datamodel-manifest.js <manifest-path> [--json]');
  process.exit(1);
}

const manifestPath = path.resolve(manifestArg);
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  const report = { valid: false, manifestPath, errors: [`Cannot read valid JSON: ${error.message}`] };
  if (jsonOutput) console.log(JSON.stringify(report, null, 2));
  else console.error(`datamodel-manifest: ${report.errors[0]}`);
  process.exit(1);
}

const errors = [];
const allowedStatuses = new Set(['new', 'extended', 'reused', 'adapted']);
const tableNames = new Set();

if (!manifest.environmentUrl || !/^https:\/\//i.test(manifest.environmentUrl)) {
  errors.push('environmentUrl must be an HTTPS URL');
}
if (!Array.isArray(manifest.tables)) {
  errors.push('tables must be an array');
}

for (const [tableIndex, table] of (manifest.tables || []).entries()) {
  const prefix = `tables[${tableIndex}]`;
  if (!table.logicalName) errors.push(`${prefix}.logicalName is required`);
  if (tableNames.has(table.logicalName)) errors.push(`${prefix}.logicalName duplicates ${table.logicalName}`);
  tableNames.add(table.logicalName);
  if (!table.entitySetName) errors.push(`${prefix}.entitySetName is required`);
  if (!table.primaryIdAttribute) errors.push(`${prefix}.primaryIdAttribute is required`);
  if (!table.primaryNameAttribute) errors.push(`${prefix}.primaryNameAttribute is required`);
  if (!Number.isInteger(table.dependencyTier) || table.dependencyTier < 0) {
    errors.push(`${prefix}.dependencyTier must be a non-negative integer`);
  }
  if (!allowedStatuses.has(String(table.status || '').toLowerCase())) {
    errors.push(`${prefix}.status must be new, extended, reused, or adapted`);
  }
  if (!Array.isArray(table.columns)) {
    errors.push(`${prefix}.columns must be an array`);
    continue;
  }

  const columnNames = new Set();
  for (const [columnIndex, column] of table.columns.entries()) {
    const columnPrefix = `${prefix}.columns[${columnIndex}]`;
    if (!column.logicalName) errors.push(`${columnPrefix}.logicalName is required`);
    if (columnNames.has(column.logicalName)) {
      errors.push(`${columnPrefix}.logicalName duplicates ${column.logicalName}`);
    }
    columnNames.add(column.logicalName);
    if (!column.schemaName) errors.push(`${columnPrefix}.schemaName is required`);
    if (!column.type) errors.push(`${columnPrefix}.type is required`);

    const type = String(column.type || '').toLowerCase();
    if (['lookup', 'customer', 'owner'].includes(type)) {
      if (!column.target) errors.push(`${columnPrefix}.target is required for lookup columns`);
      if (!column.targetEntitySetName) {
        errors.push(`${columnPrefix}.targetEntitySetName is required for lookup columns`);
      }
    }
    if (['choice', 'picklist', 'multiselectchoice', 'boolean'].includes(type)) {
      if (!Array.isArray(column.options) || !column.options.length) {
        errors.push(`${columnPrefix}.options must contain live integer/label pairs for ${column.type}`);
      } else {
        const values = new Set();
        for (const [optionIndex, option] of column.options.entries()) {
          if (!Number.isInteger(option?.value) || !String(option?.label || '').trim()) {
            errors.push(`${columnPrefix}.options[${optionIndex}] requires integer value and non-empty label`);
          }
          if (values.has(option?.value)) {
            errors.push(`${columnPrefix}.options contains duplicate value ${option?.value}`);
          }
          values.add(option?.value);
        }
      }
    }
  }
}

const report = {
  valid: errors.length === 0,
  manifestPath,
  tableCount: Array.isArray(manifest.tables) ? manifest.tables.length : 0,
  errors,
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else if (report.valid) {
  console.log(`datamodel-manifest: PASS (${report.tableCount} table(s))`);
} else {
  console.error('datamodel-manifest: FAIL');
  for (const error of errors) console.error(`- ${error}`);
}

process.exit(report.valid ? 0 : 1);