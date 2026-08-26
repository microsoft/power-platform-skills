#!/usr/bin/env node
'use strict';

/**
 * Validates native capture evidence for a prompt-derived experience contract.
 * Absence of native capture support is an explicit unavailable result (exit 1),
 * never a false claim of visual completion.
 */

const fs = require('node:fs');
const path = require('node:path');
const { validateExperienceContract } = require('./experience-patterns');
const { validateScreenBuildPack } = require('./validate-screen-build-pack');
const { keyFlowSteps } = require('./compile-screen-build-pack');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--manifest') args.manifest = argv[++index];
    else if (argv[index] === '--json') args.json = true;
    else if (argv[index] === '--help' || argv[index] === '-h') args.help = true;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hasNativeCaptureEvidence(capture, projectRoot) {
  const captureId = String(capture?.captureId || '').trim();
  if (captureId && !/^experience-(?:region|motif|primary-action)/.test(captureId)) return true;
  const rawPath = capture?.path || capture?.file || capture?.screenshot;
  if (typeof rawPath !== 'string' || !rawPath.trim()) return false;
  const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath);
  return fs.existsSync(resolved);
}

function captureMatches(capture, expectedRoute, largeText, projectRoot) {
  const captureRoute = String(capture?.route || capture?.screen || '');
  const scale = Number(capture?.fontScale || 1);
  const platform = String(capture?.platform || '').toLowerCase();
  return captureRoute === expectedRoute
    && (largeText ? scale >= 1.3 : scale < 1.3)
    && ['ios', 'android'].includes(platform)
    && typeof capture?.device === 'string'
    && capture.device.trim().length > 0
    && ['pass', 'passed'].includes(String(capture?.status || capture?.result || '').toLowerCase())
    && hasNativeCaptureEvidence(capture, projectRoot);
}

function loadKeyFlow(projectRoot, issues) {
  const screenContractPath = path.join(projectRoot, '.tmp', 'experience-screen-contract.json');
  if (!fs.existsSync(screenContractPath)) {
    issues.push({ rule: 'missing-screen-contract', message: 'Experience screen contract is missing for visual review.' });
    return null;
  }
  try {
    const screenContract = readJson(screenContractPath);
    const keyFlow = screenContract.keyFlow;
    if (!keyFlow || typeof keyFlow.route !== 'string' || typeof keyFlow.outcome !== 'string') {
      issues.push({ rule: 'missing-key-flow-contract', message: 'Experience screen contract must declare a keyFlow for visual review.' });
      return null;
    }
    return keyFlow;
  } catch (error) {
    issues.push({ rule: 'invalid-screen-contract', message: `Experience screen contract is invalid: ${error.message}` });
    return null;
  }
}

function loadBuildPack(projectRoot, issues) {
  const packPath = path.join(projectRoot, '.tmp', 'screen-build-pack.json');
  if (!fs.existsSync(packPath)) return null;
  try {
    const pack = readJson(packPath);
    const validation = validateScreenBuildPack(projectRoot, pack);
    if (validation.issues.length) {
      issues.push({ rule: 'invalid-screen-build-pack', message: `Screen build pack is invalid: ${validation.issues.map((issue) => issue.rule).join(', ')}.` });
      return null;
    }
    return pack;
  } catch (error) {
    issues.push({ rule: 'invalid-screen-build-pack', message: `Screen build pack is invalid: ${error.message}` });
    return null;
  }
}

function hasAcceptedReview(check, captureIds) {
  const status = String(check?.status || check?.result || '').toLowerCase();
  const evidence = Array.isArray(check?.evidence) ? check.evidence : [check?.evidence];
  const hasEvidence = evidence.some((value) => typeof value === 'string' && value.trim());
  const linkedCaptures = Array.isArray(check?.captureIds) ? check.captureIds : [];
  const hasCaptureLink = linkedCaptures.some((captureId) => captureIds.has(String(captureId)));
  if (['pass', 'passed'].includes(status)) return hasEvidence && hasCaptureLink;
  return ['not-applicable', 'not applicable'].includes(status)
    && hasEvidence
    && hasCaptureLink
    && typeof check?.reason === 'string'
    && check.reason.trim().length > 0;
}

function validate(projectRoot, manifest) {
  const issues = [];
  const contractPath = path.join(projectRoot, '.tmp', 'experience-contract.json');
  if (!fs.existsSync(contractPath)) return [{ rule: 'missing-contract', message: 'Experience contract is missing.' }];
  let contract;
  try { contract = readJson(contractPath); } catch (error) { return [{ rule: 'invalid-contract', message: error.message }]; }
  for (const message of validateExperienceContract(contract)) issues.push({ rule: 'invalid-contract', message });
  const keyFlow = loadKeyFlow(projectRoot, issues);
  const buildPack = loadBuildPack(projectRoot, issues);
  if (!manifest || manifest.schemaVersion !== 1) {
    issues.push({ rule: 'invalid-manifest', message: 'Experience visual review manifest requires schemaVersion: 1.' });
    return issues;
  }
  if (manifest.experienceContractRoute !== contract.primaryScreen.route) {
    issues.push({ rule: 'route-drift', message: 'Visual review manifest does not target the contract primary route.' });
  }
  if (keyFlow && manifest.keyFlowRoute !== keyFlow.route) {
    issues.push({ rule: 'key-flow-route-drift', message: 'Visual review manifest does not target the contract key-flow route.' });
  }
  const keyFlowRoutes = keyFlowSteps(keyFlow).map((screen) => screen.route);
  const manifestKeyFlowRoutes = Array.isArray(manifest.keyFlowRoutes) && manifest.keyFlowRoutes.length
    ? manifest.keyFlowRoutes
    : manifest.keyFlowRoute ? [manifest.keyFlowRoute] : [];
  if (keyFlow && JSON.stringify(manifestKeyFlowRoutes) !== JSON.stringify(keyFlowRoutes)) {
    issues.push({ rule: 'key-flow-routes-drift', message: 'Visual review manifest does not target every ordered contract key-flow route.' });
  }
  if (buildPack && buildPack.navigation?.initialRoute !== contract.primaryScreen.route) {
    issues.push({ rule: 'build-pack-primary-route-drift', message: 'Screen build pack initialRoute does not match the experience primary route.' });
  }
  if (buildPack && keyFlow && buildPack.navigation?.keyFlowRoute !== keyFlow.route) {
    issues.push({ rule: 'build-pack-key-flow-drift', message: 'Screen build pack keyFlowRoute does not match the experience screen contract.' });
  }
  if (buildPack && keyFlow && JSON.stringify(buildPack.navigation?.keyFlowRoutes || []) !== JSON.stringify(keyFlowRoutes)) {
    issues.push({ rule: 'build-pack-key-flow-routes-drift', message: 'Screen build pack keyFlowRoutes do not match the ordered experience screen contract.' });
  }
  const captures = Array.isArray(manifest.captureMatrix) ? manifest.captureMatrix : [];
  const captureIds = new Set(captures.map((capture) => String(capture?.captureId || '').trim()).filter(Boolean));
  for (const platform of ['ios', 'android']) {
    if (!captures.some((capture) => String(capture?.platform || '').toLowerCase() === platform && hasNativeCaptureEvidence(capture, projectRoot))) {
      issues.push({ rule: 'missing-native-platform-coverage', message: `Missing native capture evidence for ${platform}.` });
    }
  }
  const reviewRoutes = [
    { id: 'primary', route: contract.primaryScreen.route },
    ...keyFlowRoutes.map((route, index) => ({
      id: keyFlowRoutes.length === 1 ? 'key-flow' : `key-flow-${index + 1}`,
      route,
    })),
  ];
  for (const reviewRoute of reviewRoutes) {
    if (!captures.some((capture) => captureMatches(capture, reviewRoute.route, false, projectRoot))) {
      issues.push({ rule: 'missing-normal-capture', message: `Missing passing native ${reviewRoute.id} capture at normal text size.`, route: reviewRoute.route });
    }
    if (!captures.some((capture) => captureMatches(capture, reviewRoute.route, true, projectRoot))) {
      issues.push({ rule: 'missing-large-text-capture', message: `Missing passing native ${reviewRoute.id} capture at large text size.`, route: reviewRoute.route });
    }
  }
  const checks = Array.isArray(manifest.checks) ? manifest.checks : [];
  const requiredChecks = ['focalPoint', 'regionOrder', 'primaryAction', 'taskFit', 'contentRealism', 'signatureMotifs', 'forbiddenDefaults', 'contrast', 'touchTargets', 'safeAreas', 'keyboard', 'offlineState', 'screenReaderOrder', 'responsiveLayout', 'localizedContent'];
  for (const expected of requiredChecks) {
    const check = checks.find((candidate) => candidate.id === expected);
    const scopes = Array.isArray(check?.scopes) ? check.scopes : [];
    if (!check || !hasAcceptedReview(check, captureIds) || !reviewRoutes.every((reviewRoute) => scopes.includes(reviewRoute.id))) {
      issues.push({ rule: 'missing-experience-check', message: `Missing passing visual review check: ${expected}.` });
    }
  }
  return issues;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.projectRoot) {
    process.stdout.write('Usage: node validate-experience-visual-evidence.js --project-root <dir> [--manifest <path>] [--json]\n');
    return args.help ? 0 : 2;
  }
  const projectRoot = path.resolve(args.projectRoot);
  const manifestPath = path.resolve(projectRoot, args.manifest || '.tmp/experience-visual-review.json');
  if (!fs.existsSync(manifestPath)) {
    const result = { validator: 'validate-experience-visual-evidence', status: 'unavailable', reason: 'native-capture-unavailable', manifest: manifestPath };
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stderr.write('UNAVAILABLE: native experience capture evidence is not available.\n');
    return 1;
  }
  let manifest;
  try { manifest = readJson(manifestPath); } catch (error) {
    process.stderr.write(`BLOCKED: invalid experience visual review manifest: ${error.message}\n`);
    return 2;
  }
  const issues = validate(projectRoot, manifest);
  const result = { validator: 'validate-experience-visual-evidence', status: issues.length ? 'fail' : 'pass', issues };
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (issues.length) {
    if (!args.json) for (const issue of issues) process.stderr.write(`- [${issue.rule}] ${issue.message}\n`);
    return 2;
  }
  if (!args.json) process.stdout.write('Experience visual evidence passed.\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validate };
