#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_OWNER = 'power-platform-skills/mobile-app';
const EXPECTED_SCHEMA = 2;
const EXPECTED_EXPERIENCE_CONTRACT = 1;

function parseArgs(argv) {
  const args = { mode: 'strict' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') args.projectRoot = argv[++index];
    else if (arg === '--mode') args.mode = argv[++index];
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function compareVersions(left, right) {
  const a = String(left || '0').split('.').map(Number);
  const b = String(right || '0').split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function checkProvenance(projectRoot, options = {}) {
  const mode = options.mode || 'strict';
  const pluginVersion = options.pluginVersion || '0.0.0';
  const markerPath = path.join(projectRoot, '.powerapps-native', 'version.json');
  const issues = [];
  const warnings = [];

  if (!fs.existsSync(markerPath)) {
    const message = 'Template provenance marker .powerapps-native/version.json is missing.';
    if (mode === 'legacy') warnings.push(message);
    else issues.push(message);
    return { issues, marker: null, markerPath, status: issues.length ? 'blocked' : 'legacy', warnings };
  }

  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
  catch (error) {
    issues.push(`Template provenance marker is invalid JSON: ${error.message}`);
    return { issues, marker: null, markerPath, status: 'blocked', warnings };
  }

  if (marker.schemaVersion !== EXPECTED_SCHEMA) issues.push(`Expected schemaVersion ${EXPECTED_SCHEMA}, received ${marker.schemaVersion}.`);
  if (marker.templateOwner !== EXPECTED_OWNER) issues.push(`Expected templateOwner ${EXPECTED_OWNER}, received ${marker.templateOwner || '<missing>'}.`);
  if (marker.experienceContractVersion !== EXPECTED_EXPERIENCE_CONTRACT) issues.push(`Expected experienceContractVersion ${EXPECTED_EXPERIENCE_CONTRACT}, received ${marker.experienceContractVersion || '<missing>'}.`);
  if (!Number.isInteger(marker.templateVersion) || marker.templateVersion < 1) issues.push('templateVersion must be a positive integer.');
  if (!marker.source || !marker.sourceRef) issues.push('source and sourceRef are required.');
  if (!marker.minimumPluginVersion) issues.push('minimumPluginVersion is required.');
  else if (compareVersions(pluginVersion, marker.minimumPluginVersion) < 0) issues.push(`Plugin ${pluginVersion} is older than required ${marker.minimumPluginVersion}.`);
  if (marker.pluginVersion && compareVersions(pluginVersion, marker.pluginVersion) < 0) warnings.push(`Template was produced by newer plugin ${marker.pluginVersion}; current plugin is ${pluginVersion}.`);

  return { issues, marker, markerPath, status: issues.length ? 'blocked' : 'ok', warnings };
}

function main(argv) {
  const args = parseArgs(argv);
  const projectRoot = path.resolve(args.projectRoot || process.cwd());
  const pluginMetadata = path.resolve(__dirname, '..', '.plugin', 'plugin.json');
  const pluginVersion = JSON.parse(fs.readFileSync(pluginMetadata, 'utf8')).version;
  const result = checkProvenance(projectRoot, { mode: args.mode, pluginVersion });
  if (args.json) process.stdout.write(`${JSON.stringify({ ...result, pluginVersion }, null, 2)}\n`);
  else {
    for (const warning of result.warnings) process.stderr.write(`WARNING: ${warning}\n`);
    if (result.status === 'blocked') {
      process.stderr.write(`BLOCKED: ${result.issues.join(' ')}\n`);
    } else {
      process.stdout.write(`Template provenance ${result.status}: ${result.markerPath}\n`);
    }
  }
  return result.status === 'blocked' ? 2 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { checkProvenance, compareVersions };
