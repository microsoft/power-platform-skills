#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateDesignContentProjection } = require('./compile-design-content-projection');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const REQUIRED_PROJECT_FILES = [
  '.tmp/experience-contract.json',
  '.tmp/context-enrichment-contract.json',
  '.tmp/experience-foundation-contract.json',
  '.tmp/experience-screen-contract.json',
  '.tmp/screen-action-contract.json',
  '.tmp/design-content-projection.json',
];
const REQUIRED_PLUGIN_FILES = [
  'skills/design-system/reference-ownership.json',
  'skills/design-system/automatic-native.md',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isInside(root, target) {
  return target.startsWith(`${root}${path.sep}`);
}

function validateDesignContextEvidence(projectRoot, evidence, options = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const pluginRoot = options.pluginRoot ? fs.realpathSync(path.resolve(options.pluginRoot)) : PLUGIN_ROOT;
  const errors = [];
  if (evidence?.schemaVersion !== 1) errors.push('design context evidence schemaVersion must be 1');
  if (evidence?.mode !== 'automatic-native') errors.push('design context evidence mode must be automatic-native');
  if (evidence?.designModelCalls !== 1) errors.push('automatic native design must record exactly one design model call');
  if (!Array.isArray(evidence?.filesRead)) errors.push('design context evidence filesRead must be an array');
  const entries = Array.isArray(evidence?.filesRead) ? evidence.filesRead : [];
  const keys = new Set();
  for (const [index, entry] of entries.entries()) {
    const label = `filesRead[${index}]`;
    if (!['project', 'plugin'].includes(entry?.scope)) {
      errors.push(`${label}.scope must be project or plugin`);
      continue;
    }
    if (typeof entry.path !== 'string' || !entry.path || path.isAbsolute(entry.path) || entry.path.includes('..')) {
      errors.push(`${label}.path must be a safe relative path`);
      continue;
    }
    const key = `${entry.scope}:${entry.path}`;
    if (keys.has(key)) errors.push(`${label} duplicates ${key}`);
    keys.add(key);
    const ownerRoot = entry.scope === 'project' ? root : pluginRoot;
    const filePath = path.resolve(ownerRoot, entry.path);
    if (!isInside(ownerRoot, filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      errors.push(`${label} does not resolve to a readable file: ${key}`);
      continue;
    }
    const bytes = fs.readFileSync(filePath);
    if (entry.bytes !== bytes.length) errors.push(`${label}.bytes does not match ${key}`);
    if (entry.sha256 !== sha256(bytes)) errors.push(`${label}.sha256 does not match ${key}`);
  }
  const navigationPath = path.join(root, '.tmp', 'navigation-contract.json');
  const requiredProject = [
    ...REQUIRED_PROJECT_FILES,
    ...(fs.existsSync(navigationPath) ? ['.tmp/navigation-contract.json'] : []),
  ];
  for (const relativePath of requiredProject) {
    if (!keys.has(`project:${relativePath}`)) errors.push(`filesRead omits required project:${relativePath}`);
  }
  for (const relativePath of REQUIRED_PLUGIN_FILES) {
    if (!keys.has(`plugin:${relativePath}`)) errors.push(`filesRead omits required plugin:${relativePath}`);
  }
  const ownershipPath = path.join(pluginRoot, 'skills', 'design-system', 'reference-ownership.json');
  if (fs.existsSync(ownershipPath)) {
    const ownership = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
    const forbidden = ownership?.modes?.['automatic-native']?.forbiddenReferences || [];
    for (const entry of entries.filter((item) => item?.scope === 'plugin')) {
      const relativeToDesignSkill = entry.path.startsWith('skills/design-system/')
        ? entry.path.slice('skills/design-system/'.length)
        : entry.path;
      if (forbidden.includes(relativeToDesignSkill)) errors.push(`automatic design read forbidden optional reference ${entry.path}`);
    }
  }
  const domainPath = path.join(root, '.tmp', 'prototype-domain-model.json');
  const projectionPath = path.join(root, '.tmp', 'design-content-projection.json');
  if (fs.existsSync(domainPath) && fs.existsSync(projectionPath)) {
    try {
      const model = JSON.parse(fs.readFileSync(domainPath, 'utf8'));
      const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
      if (!validateDesignContentProjection(model, projection).valid) errors.push('design content projection is stale');
    } catch (error) {
      errors.push(`cannot validate design content projection: ${error.message}`);
    }
  } else {
    errors.push('prototype domain model and design content projection are required');
  }
  return { valid: errors.length === 0, errors };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--evidence') args.evidence = argv[++index];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-design-context-evidence.js --project-root <dir> [--evidence .tmp/design-context-evidence.json]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const evidencePath = path.resolve(root, args.evidence || '.tmp/design-context-evidence.json');
    if (!isInside(root, evidencePath)) throw new Error('evidence path must remain inside project root');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const result = validateDesignContextEvidence(root, evidence);
    if (!result.valid) throw new Error(result.errors.join('; '));
    process.stdout.write(`Design context evidence valid: ${evidencePath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`validate-design-context-evidence: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  REQUIRED_PLUGIN_FILES,
  REQUIRED_PROJECT_FILES,
  main,
  parseArgs,
  sha256,
  validateDesignContextEvidence,
};
