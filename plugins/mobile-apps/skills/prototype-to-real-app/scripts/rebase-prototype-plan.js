#!/usr/bin/env node
'use strict';

/**
 * Rebase only contract-proven prototype identifiers from `cr_` to the selected
 * environment's publisher prefix. The archived contract remains immutable;
 * the rebased copy is still non-executable until live reconciliation.
 *
 * Usage:
 *   node rebase-prototype-plan.js <project-dir> <publisher-prefix>
 */

const fs = require('node:fs');
const path = require('node:path');

const [, , projectArg, prefixArg] = process.argv;
if (!projectArg || !prefixArg) {
  console.error('Usage: node rebase-prototype-plan.js <project-dir> <publisher-prefix>');
  process.exit(1);
}

const projectDir = path.resolve(projectArg);
const publisherPrefix = String(prefixArg).replace(/_+$/, '');
if (!/^[a-z][a-z0-9]{1,10}$/i.test(publisherPrefix)) {
  console.error(`prototype-rebase: invalid publisher prefix ${JSON.stringify(prefixArg)}`);
  process.exit(1);
}

const planPath = path.join(projectDir, 'native-app-plan.md');
const archiveDir = path.join(projectDir, '.tmp', 'prototype-plan-artifacts');
const archivedContractPath = path.join(archiveDir, 'dataverse-schema-contract.json');
const currentContractPath = path.join(projectDir, '.tmp', 'dataverse-schema-contract.json');
const contractPath = fs.existsSync(archivedContractPath) ? archivedContractPath : currentContractPath;
const outputPath = path.join(archiveDir, 'rebased-schema-contract.json');
const mappingPath = path.join(archiveDir, 'publisher-prefix-map.json');

function fail(message) {
  console.error(`prototype-rebase: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(planPath)) fail('native-app-plan.md is missing');
if (!fs.existsSync(contractPath)) fail('prototype schema contract is missing');

let contract;
try {
  contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
} catch (error) {
  fail(`cannot parse prototype schema contract: ${error.message}`);
}
if (contract.planningMode !== 'prototype' || contract.executionEligible !== false) {
  fail('schema contract is not a non-executable prototype contract');
}

const identifiers = new Set();
function collect(value) {
  if (typeof value === 'string' && /^cr_[a-z0-9_]+$/i.test(value)) {
    identifiers.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(collect);
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(collect);
  }
}
collect(contract);

if (!identifiers.size) fail('prototype contract contains no cr_ identifiers to rebase');

const mapping = new Map(
  [...identifiers]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map((identifier) => [identifier, `${publisherPrefix}_${identifier.slice(3)}`]),
);

function replaceContractValue(value) {
  if (typeof value === 'string') return mapping.get(value) || value;
  if (Array.isArray(value)) return value.map(replaceContractValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceContractValue(child)]));
  }
  return value;
}

let plan = fs.readFileSync(planPath, 'utf8');
for (const [from, to] of mapping) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  plan = plan.replace(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g'), to);
}

const rebasedContract = replaceContractValue(contract);
rebasedContract.publisherPrefix = publisherPrefix;
rebasedContract.planningMode = 'prototype-rebased';
rebasedContract.executionEligible = false;
rebasedContract.rebasedFrom = 'prototype';

fs.mkdirSync(archiveDir, { recursive: true });
fs.writeFileSync(planPath, plan);
fs.writeFileSync(outputPath, `${JSON.stringify(rebasedContract, null, 2)}\n`);
fs.writeFileSync(mappingPath, `${JSON.stringify({
  schemaVersion: 1,
  publisherPrefix,
  mappings: Object.fromEntries(mapping),
}, null, 2)}\n`);

console.log(`prototype-rebase: updated ${mapping.size} contract-proven identifier(s) to ${publisherPrefix}_`);
console.log(`prototype-rebase: wrote ${path.relative(projectDir, mappingPath).split(path.sep).join('/')}`);