#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { revisionForPack, sha256 } = require('./compile-screen-build-pack');

function currentSourceHash(projectRoot, relativePath, source) {
  if (source === 'designRecipe') {
    const design = path.join(projectRoot, 'brand/design-system.md');
    const tokens = path.join(projectRoot, 'brand/tokens.ts');
    if (!fs.existsSync(design) || !fs.existsSync(tokens)) return null;
    return sha256(`${fs.readFileSync(design, 'utf8')}\n${fs.readFileSync(tokens, 'utf8')}`);
  }
  const filePath = path.join(projectRoot, relativePath);
  return fs.existsSync(filePath) ? sha256(fs.readFileSync(filePath, 'utf8')) : null;
}

function validateScreenBuildPack(projectRoot, pack) {
  const issues = [];
  const staleTargets = new Set();
  if (!pack || pack.schemaVersion !== 1) {
    return { issues: [{ rule: 'invalid-schema-version', message: 'Screen build pack requires schemaVersion: 1.' }], staleTargets: [] };
  }
  if (!/^[a-f0-9]{64}$/i.test(String(pack.revision || '')) || pack.revision !== revisionForPack(pack)) {
    issues.push({ rule: 'revision-drift', message: 'Screen build pack revision does not match its deterministic content.' });
  }
  const sourceNames = ['plan', 'experienceContract', 'screenContract', 'foundationContract', 'designRecipe', 'dataIntent'];
  for (const source of sourceNames) {
    if (!/^[a-f0-9]{64}$/i.test(String(pack.sources?.[source] || ''))) {
      issues.push({ rule: 'missing-source-hash', message: `Screen build pack is missing ${source} hash.` });
      continue;
    }
    const current = currentSourceHash(projectRoot, pack.sourcePaths?.[source], source);
    if (!current || current !== pack.sources[source]) {
      issues.push({ rule: 'source-hash-drift', message: `Screen build pack source drift: ${source}.`, source });
      for (const [screenId, dependencies] of Object.entries(pack.invalidation?.screenDependencies || {})) {
        if (Array.isArray(dependencies) && dependencies.includes(source)) staleTargets.add(`screen:${screenId}`);
      }
      for (const [fixtureId, dependencies] of Object.entries(pack.invalidation?.fixtureDependencies || {})) {
        if (Array.isArray(dependencies) && dependencies.includes(source)) staleTargets.add(`fixture:${fixtureId}`);
      }
      for (const [validatorId, dependencies] of Object.entries(pack.invalidation?.validatorDependencies || {})) {
        if (Array.isArray(dependencies) && dependencies.includes(source)) staleTargets.add(`validator:${validatorId}`);
      }
    }
  }
  const primary = (pack.screens || []).find((screen) => screen.role === 'primary');
  const keyFlowRoutes = pack.navigation?.keyFlowRoutes || (pack.navigation?.keyFlowRoute ? [pack.navigation.keyFlowRoute] : []);
  const screenByRoute = new Map((pack.screens || []).map((screen) => [screen.route, screen]));
  const keyFlowScreens = keyFlowRoutes.map((route) => screenByRoute.get(route));
  const profile = (pack.screens || []).find((screen) => screen.role === 'profile');
  if (!primary || !keyFlowRoutes.length || keyFlowScreens.some((screen) => !screen || screen.role !== 'key-flow') || pack.navigation?.keyFlowRoute !== keyFlowRoutes[0]) {
    issues.push({ rule: 'missing-primary-or-key-flow', message: 'Screen build pack requires Home plus an ordered non-empty key-flow route sequence.' });
  }
  if (!profile || profile.route !== '/(app)/profile' || profile.file !== 'app/(app)/profile.tsx' || !(pack.navigation?.routes || []).includes(profile.route) || pack.navigation?.profileRoute !== profile.route) {
    issues.push({ rule: 'missing-or-unreachable-profile', message: 'Screen build pack requires a reachable Profile screen at /(app)/profile.' });
  }
  if (!primary?.firstViewport?.length || !primary?.primaryAction || !Array.isArray(primary?.states) || !['loading', 'empty', 'error', 'offline'].every((state) => primary.states.includes(state)) || !Array.isArray(primary?.dependencies) || !Array.isArray(primary?.testIds)) {
    issues.push({ rule: 'incomplete-primary-screen', message: 'Primary build-pack screen requires viewport, action, states, dependencies, and test IDs.' });
  }
  if (pack.shell?.safeAreaOwner !== 'screen' || pack.shell?.rootSafeAreaProviderOnly !== true || !pack.shell?.headerModes || primary?.headerMode !== 'root' || keyFlowScreens.some((screen) => screen?.headerMode !== 'back') || profile?.headerMode !== 'root') {
    issues.push({ rule: 'invalid-shell-contract', message: 'Screen build pack requires route-owned safe areas plus root/back header modes.' });
  }
  if (!['tabs-stack', 'stack', 'modal-flow', 'drawer', 'other'].includes(pack.navigation?.model)) {
    issues.push({ rule: 'invalid-navigation-model', message: 'Screen build pack requires the resolved experience navigation model.' });
  }
  if (!['approved-screen-plan', 'experience-contract'].includes(pack.navigation?.modelSource)) {
    issues.push({ rule: 'invalid-navigation-source', message: 'Screen build pack must identify the approved source of its navigation model.' });
  }
  const canaryIds = pack.execution?.canary?.screenIds || [];
  const canaryRoutes = pack.execution?.canary?.routes || [];
  const expectedCanaryIds = [primary?.id, ...keyFlowScreens.map((screen) => screen?.id)];
  const expectedCanaryRoutes = [primary?.route, ...keyFlowRoutes];
  if (pack.execution?.metroAfterCanary !== true
    || canaryIds.length !== expectedCanaryIds.length
    || canaryRoutes.length !== expectedCanaryRoutes.length
    || canaryIds.some((screenId, index) => screenId !== expectedCanaryIds[index])
    || canaryRoutes.some((route, index) => route !== expectedCanaryRoutes[index])) {
    issues.push({ rule: 'invalid-native-canary', message: 'Screen build pack canary must contain Home followed by every ordered key-flow screen.' });
  }
  const supportingIds = (pack.execution?.supportingWaves || []).flatMap((wave) => wave?.screenIds || []);
  const expectedSupportingIds = (pack.screens || []).filter((screen) => !['primary', 'key-flow'].includes(screen.role)).map((screen) => screen.id);
  if ((pack.execution?.supportingWaves || []).some((wave) => !Number.isInteger(wave?.wave) || !Array.isArray(wave?.routes) || (wave.screenIds || []).length > 5)
    || supportingIds.length !== new Set(supportingIds).size
    || expectedSupportingIds.some((screenId) => !supportingIds.includes(screenId))
    || supportingIds.some((screenId) => !expectedSupportingIds.includes(screenId))) {
    issues.push({ rule: 'invalid-supporting-waves', message: 'Supporting waves must cover each non-canary screen exactly once with at most five screens per wave.' });
  }
  for (const screen of pack.screens || []) {
    if (typeof screen.presentation !== 'string' || !Object.hasOwn(screen, 'nativeIntent') || (screen.nativeIntent !== null && typeof screen.nativeIntent !== 'string')) {
      issues.push({ rule: 'screen-intent-missing', message: `Screen build pack requires presentation and native capability intent for ${screen.route || screen.id}.` });
    }
    if (!['root', 'back', 'close', 'none'].includes(screen.headerMode) || pack.shell?.headerModes?.[screen.route] !== screen.headerMode) {
      issues.push({ rule: 'header-mode-drift', message: `Screen build pack header mode drift for ${screen.route || screen.id}.` });
    }
    if (screen.data?.recordIdentity !== 'stable-primary-key' || screen.data?.viewModel !== 'src/generated/experience-view-model.ts' || !Array.isArray(screen.data?.entities)) {
      issues.push({ rule: 'screen-data-identity-missing', message: `Screen build pack requires stable-ID view-model data for ${screen.route || screen.id}.` });
    }
    if (screen.data?.mediaPolicy !== pack.fixtures?.mediaPolicy || !Array.isArray(screen.data?.mediaFields) || screen.data.mediaFields.join('|') !== 'imageUrl|imageAltText|imageCacheKey|imageAssetKey') {
      issues.push({ rule: 'screen-media-intent-drift', message: `Screen build pack media intent drift for ${screen.route || screen.id}.` });
    }
  }
  if (!pack.design?.tokensPath || !Array.isArray(pack.design?.primitives) || !pack.design.primitives.length) {
    issues.push({ rule: 'missing-design-primitives', message: 'Screen build pack requires design tokens and foundation primitives.' });
  }
  if (!pack.fixtures?.adapter || !Array.isArray(pack.fixtures?.entities) || !pack.fixtures.assetPolicy || !pack.fixtures.assetManifest || pack.fixtures?.viewModel !== 'src/generated/experience-view-model.ts' || pack.fixtures?.recordIdentity !== 'stable-primary-key' || pack.fixtures?.mediaPolicy !== pack.fixtures?.assetPolicy || pack.fixtures?.mediaManifest !== pack.fixtures?.assetManifest || !Array.isArray(pack.fixtures?.mediaFields) || pack.fixtures.mediaFields.join('|') !== 'imageUrl|imageAltText|imageCacheKey|imageAssetKey') {
    issues.push({ rule: 'missing-fixture-intent', message: 'Screen build pack requires fixture adapter, entities, and asset policy.' });
  }
  return { issues, staleTargets: [...staleTargets].sort() };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-screen-build-pack.js --project-root <dir> [--pack <path>] [--json]\n');
    return 2;
  }
  const root = path.resolve(args.projectRoot);
  const packPath = path.resolve(root, args.pack || '.tmp/screen-build-pack.json');
  if (!fs.existsSync(packPath)) {
    process.stderr.write(`BLOCKED: screen build pack is missing: ${packPath}\n`);
    return 2;
  }
  let pack;
  try { pack = JSON.parse(fs.readFileSync(packPath, 'utf8')); } catch (error) {
    process.stderr.write(`BLOCKED: invalid screen build pack: ${error.message}\n`);
    return 2;
  }
  const result = validateScreenBuildPack(root, pack);
  if (args.json) process.stdout.write(`${JSON.stringify({ validator: 'validate-screen-build-pack', pack: packPath, ...result }, null, 2)}\n`);
  if (result.issues.length) {
    if (!args.json) result.issues.forEach((issue) => process.stderr.write(`- [${issue.rule}] ${issue.message}\n`));
    return 2;
  }
  if (!args.json) process.stdout.write(`Screen build pack passed: ${packPath}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateScreenBuildPack };