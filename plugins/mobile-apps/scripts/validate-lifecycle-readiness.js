#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${error.message}`);
  }
}

function validateLifecycleReadiness(projectRoot, consumer) {
  const root = path.resolve(projectRoot);
  const state = readJson(path.join(root, '.mobile-app', 'state.json'), 'lifecycle state');
  const domainPath = path.join(root, '.tmp', 'prototype-domain-model.json');
  const contextPath = path.join(root, '.tmp', 'context-enrichment-contract.json');
  const journeyPath = path.join(root, '.tmp', 'workflow-journey-contract.json');
  const navigationPath = path.join(root, '.tmp', 'navigation-contract.json');
  const navigationShellPath = path.join(root, '.mobile-app', 'navigation-shell.json');
  const experiencePath = path.join(root, '.tmp', 'experience-contract.json');
  const pack = readJson(path.join(root, '.tmp', 'screen-build-pack.json'), 'screen build pack');
  const experience = readJson(experiencePath, 'Experience contract');
  const errors = [];
  if (state.lastValidation?.status !== 'passed') errors.push('lifecycle has no recorded passing validation');
  if (!['statically-validated', 'runtime-validated'].includes(state.lastValidation?.qualityStatus)) errors.push('lifecycle quality status is missing or unsupported');
  if (state.lastValidation?.buildPackRevision !== pack.revision) errors.push('recorded validation uses a stale build-pack revision');
  if (!fs.existsSync(domainPath) || state.lastDomainModelHash !== sha256(fs.readFileSync(domainPath))) errors.push('recorded Domain Model hash is stale');
  if (!fs.existsSync(contextPath) || state.lastContextEnrichmentHash !== sha256(fs.readFileSync(contextPath))) errors.push('recorded Context Enrichment hash is stale');
  if (!fs.existsSync(journeyPath) || state.lastWorkflowJourneyHash !== sha256(fs.readFileSync(journeyPath))) errors.push('recorded Workflow Journey hash is stale');
  if (!fs.existsSync(navigationPath) || state.lastNavigationContractHash !== sha256(fs.readFileSync(navigationPath))) errors.push('recorded Navigation Contract hash is stale');
  if (!fs.existsSync(navigationShellPath) || state.lastNavigationShellHash !== sha256(fs.readFileSync(navigationShellPath))) errors.push('recorded Navigation Shell hash is stale');
  if (state.lastVisualCompositionHash !== sha256(stableStringify(experience.visualCompositionIntent))) errors.push('recorded Visual Composition hash is stale');
  if (state.dataMode === 'prototype' && state.lastValidation?.nativeVisualEvidence != null) errors.push('prototype static lifecycle readiness must not contain native visual evidence');
  if (consumer === 'deploy') {
    if (state.dataMode !== 'dataverse') errors.push('deploy requires lifecycle dataMode dataverse');
    if (state.lastValidation?.qualityStatus !== 'runtime-validated') errors.push('deploy requires runtime-validated lifecycle quality');
  }
  return { valid: errors.length === 0, consumer, dataMode: state.dataMode, qualityStatus: state.lastValidation?.qualityStatus || null, buildPackRevision: pack.revision || null, errors };
}

function main(argv) {
  const args = { consumer: 'preview' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--consumer') args.consumer = argv[++index];
  }
  if (!args.projectRoot || !['preview', 'debug', 'deploy'].includes(args.consumer)) {
    process.stderr.write('Usage: node validate-lifecycle-readiness.js --project-root <dir> --consumer preview|debug|deploy\n');
    return 2;
  }
  try {
    const result = validateLifecycleReadiness(args.projectRoot, args.consumer);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.valid ? 0 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ valid: false, consumer: args.consumer, errors: [error.message] }, null, 2)}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateLifecycleReadiness };