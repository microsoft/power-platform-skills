#!/usr/bin/env node

// Guards the fast new-table path used by /add-dataverse. Dataverse accepts all
// ordinary columns in the initial EntityDefinitions POST, but the API cannot
// infer which columns the approved plan expected. Comparing the generated body
// with an explicit expected-name list prevents an incomplete table shell from
// silently pushing the remaining columns onto the slower extension path.

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(args) {
  const out = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((arg === '--body' || arg === '--expected') && args[index + 1]) {
      out[arg.slice(2)] = args[++index];
    }
  }
  return out;
}

function readJsonArg(value, label) {
  if (!value) throw new Error(`Missing --${label}`);
  const raw = value.startsWith('@')
    ? fs.readFileSync(path.resolve(value.slice(1)), 'utf8')
    : value;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON for --${label}: ${error.message}`);
  }
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function attributeName(attribute) {
  return normalizeName(attribute && (attribute.SchemaName || attribute.LogicalName));
}

function isLookupAttribute(attribute) {
  const metadataType = String(attribute && attribute['@odata.type'] || '').toLowerCase();
  const attributeType = String(attribute && attribute.AttributeType || '').toLowerCase();
  return metadataType.endsWith('lookupattributemetadata')
    || ['lookup', 'customer', 'owner'].includes(attributeType);
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function validateTableCreatePayload(payload, expectedInput) {
  const issues = [];
  const attributes = Array.isArray(payload && payload.Attributes) ? payload.Attributes : [];
  const expectedColumns = Array.isArray(expectedInput)
    ? expectedInput.map(normalizeName).filter(Boolean)
    : [];
  const actualColumns = attributes.map(attributeName).filter(Boolean);
  const duplicateExpectedColumns = duplicates(expectedColumns);
  const duplicateActualColumns = duplicates(actualColumns);
  const expectedSet = new Set(expectedColumns);
  const actualSet = new Set(actualColumns);
  const missingColumns = [...expectedSet].filter((name) => !actualSet.has(name)).sort();
  const unexpectedColumns = [...actualSet].filter((name) => !expectedSet.has(name)).sort();
  const lookupColumns = attributes.filter(isLookupAttribute).map(attributeName).filter(Boolean).sort();
  const primaryAttributes = attributes.filter((attribute) => attribute && attribute.IsPrimaryName === true);
  const primaryNameAttribute = normalizeName(payload && payload.PrimaryNameAttribute);
  const actualPrimaryName = primaryAttributes.length === 1 ? attributeName(primaryAttributes[0]) : '';

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    issues.push('Create payload must be a JSON object.');
  }
  if (!Array.isArray(payload && payload.Attributes)) {
    issues.push('Create payload must contain an Attributes array.');
  }
  if (!Array.isArray(expectedInput) || expectedColumns.length === 0) {
    issues.push('Expected columns must be a non-empty JSON array of names.');
  }
  if (attributes.some((attribute) => !attributeName(attribute))) {
    issues.push('Every inline attribute must have SchemaName or LogicalName.');
  }
  if (duplicateExpectedColumns.length > 0) {
    issues.push(`Expected column list contains duplicates: ${duplicateExpectedColumns.join(', ')}.`);
  }
  if (duplicateActualColumns.length > 0) {
    issues.push(`Attributes contains duplicates: ${duplicateActualColumns.join(', ')}.`);
  }
  if (missingColumns.length > 0) {
    issues.push(`Attributes is missing planned columns: ${missingColumns.join(', ')}.`);
  }
  if (unexpectedColumns.length > 0) {
    issues.push(`Attributes contains unexpected columns: ${unexpectedColumns.join(', ')}.`);
  }
  if (lookupColumns.length > 0) {
    issues.push(`Lookup columns belong in the relationship pass: ${lookupColumns.join(', ')}.`);
  }
  if (primaryAttributes.length !== 1) {
    issues.push(`Attributes must contain exactly one IsPrimaryName=true column; found ${primaryAttributes.length}.`);
  }
  if (!primaryNameAttribute) {
    issues.push('Create payload must set PrimaryNameAttribute.');
  } else if (actualPrimaryName && primaryNameAttribute !== actualPrimaryName) {
    issues.push(`PrimaryNameAttribute ${primaryNameAttribute} does not match ${actualPrimaryName}.`);
  }

  return {
    ok: issues.length === 0,
    expectedCount: expectedColumns.length,
    attributeCount: actualColumns.length,
    expectedColumns,
    actualColumns,
    missingColumns,
    unexpectedColumns,
    duplicateColumns: duplicateActualColumns,
    lookupColumns,
    issues,
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const payload = readJsonArg(args.body, 'body');
    const expected = readJsonArg(args.expected, 'expected');
    const result = validateTableCreatePayload(payload, expected);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  validateTableCreatePayload,
};