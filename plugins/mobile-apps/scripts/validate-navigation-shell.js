#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { navigationContractRevision } = require('./resolve-navigation-contract');
const { navigationShellArtifacts, patchAppLayout, shellFingerprint } = require('./apply-navigation-shell');

function validateNavigationShell(projectRoot, contract, screenContract) {
  const root = path.resolve(projectRoot);
  const issues = [];
  const manifestPath = path.join(root, '.mobile-app', 'navigation-shell.json');
  if (!fs.existsSync(manifestPath)) return [{ rule: 'navigation-shell-manifest-missing', message: 'Navigation shell manifest is missing.' }];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (error) { return [{ rule: 'navigation-shell-manifest-invalid', message: error.message }]; }
  const expected = navigationShellArtifacts(contract, screenContract);
  const appLayout = path.join(root, 'app', '(app)', '_layout.tsx');
  const appLayoutContent = fs.existsSync(appLayout) ? fs.readFileSync(appLayout, 'utf8') : '';
  const expectedFingerprint = shellFingerprint({ ...expected, 'app/(app)/_layout.tsx': patchAppLayout(appLayoutContent) });
  if (manifest.navigationContractRevision !== navigationContractRevision(contract)) issues.push({ rule: 'navigation-shell-contract-drift', message: 'Navigation shell was generated from a stale Navigation Contract.' });
  if (manifest.shellFingerprint !== expectedFingerprint) issues.push({ rule: 'navigation-shell-fingerprint-drift', message: 'Navigation shell manifest fingerprint is stale.' });
  for (const [relativePath, content] of Object.entries(expected)) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) issues.push({ rule: 'navigation-shell-file-missing', file: relativePath, message: `Generated navigation file is missing: ${relativePath}.` });
    else if (fs.readFileSync(filePath, 'utf8') !== content) issues.push({ rule: 'navigation-shell-file-drift', file: relativePath, message: `Generated navigation file drifted from the contract: ${relativePath}.` });
  }
  if (!/AppNavigationShell/.test(appLayoutContent) || !/<AppNavigationShell\s*\/>/.test(appLayoutContent)) issues.push({ rule: 'app-navigation-shell-not-mounted', file: 'app/(app)/_layout.tsx', message: 'Protected app layout does not mount the generated navigation shell.' });
  return issues;
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--navigation-contract') args.navigationContract = argv[++index];
    else if (argv[index] === '--screen-contract') args.screenContract = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-navigation-shell.js --project-root <dir> [--navigation-contract <path>] [--screen-contract <path>] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const readJson = (value, fallback) => JSON.parse(fs.readFileSync(path.resolve(root, value || fallback), 'utf8'));
    const issues = validateNavigationShell(root, readJson(args.navigationContract, '.tmp/navigation-contract.json'), readJson(args.screenContract, '.tmp/experience-screen-contract.json'));
    if (args.json) process.stdout.write(`${JSON.stringify({ validator: 'validate-navigation-shell', valid: issues.length === 0, issues }, null, 2)}\n`);
    else if (issues.length) issues.forEach((item) => process.stderr.write(`- [${item.rule}] ${item.message}\n`));
    else process.stdout.write('Navigation shell valid.\n');
    return issues.length ? 2 : 0;
  } catch (error) {
    process.stderr.write(`validate-navigation-shell: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateNavigationShell };