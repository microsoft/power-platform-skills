#!/usr/bin/env node
'use strict';

/**
 * Compile the approved product contracts into one compact, immutable assembly
 * sheet for parallel screen builders. It deliberately stores pointers and
 * decisions rather than copying the large Markdown references the planners use.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  contractHash,
  foundationContract,
  primaryComposition,
  validateExperienceContract,
} = require('./experience-patterns');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function requiredFile(projectRoot, relativePath, label) {
  const filePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${relativePath}`);
  return filePath;
}

function toCells(line) {
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

function parseScreenMap(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim().toLowerCase() === '### screen map');
  if (index < 0) return [];
  const table = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor].trim();
    if (/^#{1,3}\s+/.test(line)) break;
    if (line.startsWith('|')) table.push(line);
  }
  if (table.length < 2) return [];
  const headers = toCells(table[0]).map((value) => value.toLowerCase());
  const routeIndex = headers.indexOf('route');
  const fileIndex = headers.indexOf('file');
  const screenIndex = headers.indexOf('screen');
  if (routeIndex < 0 || fileIndex < 0 || screenIndex < 0) return [];
  return table.slice(2)
    .filter((line) => !/^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line))
    .map(toCells)
    .filter((cells) => cells.length > Math.max(routeIndex, fileIndex, screenIndex))
    .map((cells) => ({
      id: cells[screenIndex] || '',
      route: cells[routeIndex] || '',
      file: cells[fileIndex] || '',
    }))
    .filter((screen) => screen.id && screen.route && screen.file);
}

function identifier(value) {
  const words = String(value || '')
    .replace(/\([^)]*\)/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('') || 'Screen';
}

function validateInputs(contract, screenContract, foundation) {
  const issues = validateExperienceContract(contract);
  if (issues.length) throw new Error(`Experience contract is invalid: ${issues.join('; ')}`);
  if (screenContract?.schemaVersion !== 1 || screenContract.experienceContractSha256 !== contractHash(contract)) {
    throw new Error('Experience screen contract is missing or stale.');
  }
  const composition = primaryComposition(contract);
  const primary = screenContract.primaryScreen;
  if (!primary || primary.route !== contract.primaryScreen.route || primary.file !== contract.primaryScreen.file || primary.compositionKind !== composition.compositionKind) {
    throw new Error('Experience screen contract does not match the primary composition.');
  }
  const keyFlow = screenContract.keyFlow;
  if (!keyFlow || typeof keyFlow.route !== 'string' || keyFlow.route === primary.route || typeof keyFlow.file !== 'string' || typeof keyFlow.outcome !== 'string') {
    throw new Error('Experience screen contract requires a non-primary keyFlow.');
  }
  const expectedFoundation = foundationContract(contract);
  if (foundation?.schemaVersion !== 1 || foundation.experienceContractSha256 !== expectedFoundation.experienceContractSha256) {
    throw new Error('Experience foundation contract is missing or stale.');
  }
  const primitives = Array.isArray(foundation.primitives) ? foundation.primitives : [];
  if (primitives.length < 2 || primitives.length > 5) throw new Error('Experience foundation contract must contain 2-5 primitives.');
  for (const expected of expectedFoundation.primitives) {
    if (!primitives.some((primitive) => primitive?.motif === expected.motif && primitive.component === expected.component && primitive.file === expected.file && primitive.testID === expected.testID)) {
      throw new Error(`Experience foundation primitive is invalid: ${expected.motif}.`);
    }
  }
}

function dataIntent(projectRoot) {
  const schemaPath = path.join(projectRoot, '.tmp', 'dataverse-schema-contract.json');
  const prototypePath = path.join(projectRoot, 'src', 'generated', '.prototype-manifest.json');
  if (fs.existsSync(schemaPath)) {
    const schema = readJson(schemaPath, 'Data intent');
    const tables = Array.isArray(schema.tables) ? schema.tables : [];
    return {
      adapter: schema.planningMode === 'prototype' ? 'local' : 'dataverse',
      entities: tables.filter((table) => table.serviceRequired !== false && table.logicalName).map((table) => table.displayName || table.logicalName),
      path: '.tmp/dataverse-schema-contract.json',
      hash: sha256(fs.readFileSync(schemaPath, 'utf8')),
    };
  }
  if (fs.existsSync(prototypePath)) {
    const manifest = readJson(prototypePath, 'Prototype data intent');
    return {
      adapter: 'local',
      entities: Array.isArray(manifest.tables) ? manifest.tables : [],
      path: 'src/generated/.prototype-manifest.json',
      hash: sha256(fs.readFileSync(prototypePath, 'utf8')),
    };
  }
  throw new Error('Data intent is missing: expected .tmp/dataverse-schema-contract.json or src/generated/.prototype-manifest.json.');
}

function screenRecord(screen, primary, keyFlow, foundation, data, contract) {
  const isPrimary = screen.route === primary.route;
  const isKeyFlow = screen.route === keyFlow.route;
  const foundationComponents = foundation.primitives.map((primitive) => primitive.component);
  return {
    id: isPrimary ? 'Home' : isKeyFlow ? identifier(keyFlow.route) : identifier(screen.id),
    route: screen.route,
    file: screen.file,
    role: isPrimary ? 'primary' : isKeyFlow ? 'key-flow' : 'supporting',
    headerMode: isPrimary ? 'root' : 'back',
    purpose: isPrimary ? contract.primaryJob : isKeyFlow ? keyFlow.outcome : `Support ${contract.primaryJob.toLowerCase()}`,
    firstViewport: isPrimary
      ? [...contract.firstViewport.regionOrder.map((region) => `experience-region-${region}`), ...foundationComponents]
      : [],
    primaryAction: isPrimary ? contract.firstViewport.primaryAction : null,
    states: ['loading', 'empty', 'error', 'offline'],
    dependencies: isPrimary
      ? [...foundation.primitives.map((primitive) => primitive.file), ...data.entities.map((entity) => `fixture:${entity}`)]
      : isKeyFlow
        ? [`screen:${primary.route}`, ...foundation.primitives.map((primitive) => primitive.file)]
        : [],
    testIds: isPrimary
      ? primary.runtimeMarkers
      : isKeyFlow
        ? ['experience-key-flow']
        : [],
    data: {
      adapter: data.adapter,
      entities: data.entities,
      viewModel: 'src/generated/experience-view-model.ts',
      recordIdentity: 'stable-primary-key',
      mediaPolicy: contract.assetPolicy.media,
      mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
    },
  };
}

function revisionForPack(pack) {
  const copy = { ...pack };
  delete copy.revision;
  return sha256(stableStringify(copy));
}

function compileScreenBuildPack(projectRoot) {
  const root = path.resolve(projectRoot);
  const experiencePath = requiredFile(root, '.tmp/experience-contract.json', 'Experience contract');
  const screenPath = requiredFile(root, '.tmp/experience-screen-contract.json', 'Experience screen contract');
  const foundationPath = requiredFile(root, '.tmp/experience-foundation-contract.json', 'Experience foundation contract');
  const planPath = requiredFile(root, 'native-app-plan.md', 'Native app plan');
  const designSystemPath = requiredFile(root, 'brand/design-system.md', 'Design recipe');
  const tokensPath = requiredFile(root, 'brand/tokens.ts', 'Design tokens');
  const contract = readJson(experiencePath, 'Experience contract');
  const screenContract = readJson(screenPath, 'Experience screen contract');
  const foundation = readJson(foundationPath, 'Experience foundation contract');
  validateInputs(contract, screenContract, foundation);
  const data = dataIntent(root);
  const screenMap = parseScreenMap(fs.readFileSync(planPath, 'utf8'));
  const primary = screenContract.primaryScreen;
  const keyFlow = screenContract.keyFlow;
  const mergedScreens = [...screenMap];
  for (const screen of [
    { id: 'Home', route: primary.route, file: primary.file },
    { id: identifier(keyFlow.route), route: keyFlow.route, file: keyFlow.file },
  ]) {
    if (!mergedScreens.some((candidate) => candidate.route === screen.route)) mergedScreens.push(screen);
  }
  const screens = mergedScreens.map((screen) => screenRecord(screen, primary, keyFlow, foundation, data, contract));
  const primaryScreen = screens.find((screen) => screen.role === 'primary');
  const keyFlowScreen = screens.find((screen) => screen.role === 'key-flow');
  const sourcePaths = {
    experienceContract: '.tmp/experience-contract.json',
    screenContract: '.tmp/experience-screen-contract.json',
    foundationContract: '.tmp/experience-foundation-contract.json',
    designSystem: 'brand/design-system.md',
    tokens: 'brand/tokens.ts',
    dataIntent: data.path,
  };
  const pack = {
    schemaVersion: 1,
    sources: {
      experienceContract: sha256(fs.readFileSync(experiencePath, 'utf8')),
      screenContract: sha256(fs.readFileSync(screenPath, 'utf8')),
      foundationContract: sha256(fs.readFileSync(foundationPath, 'utf8')),
      designRecipe: sha256(`${fs.readFileSync(designSystemPath, 'utf8')}\n${fs.readFileSync(tokensPath, 'utf8')}`),
      dataIntent: data.hash,
    },
    sourcePaths,
    experience: {
      audience: contract.audience,
      primaryJob: contract.primaryJob,
      interactionMode: contract.interactionMode,
      entryMode: contract.entryMode,
      primarySurface: contract.primarySurface,
      contentModel: contract.contentModel,
      assetPolicy: contract.assetPolicy,
      forbiddenDefaults: contract.forbiddenDefaults,
      firstViewport: contract.firstViewport,
      signatureMotifs: contract.signatureMotifs,
      promptEvidence: contract.promptEvidence,
    },
    design: {
      tokensPath: 'brand/tokens.ts',
      designSystemPath: 'brand/design-system.md',
      primitives: foundation.primitives.map((primitive) => ({
        motif: primitive.motif,
        component: primitive.component,
        file: primitive.file,
        testID: primitive.testID,
      })),
    },
    shell: {
      safeAreaOwner: 'screen',
      rootSafeAreaProviderOnly: true,
      headerModes: Object.fromEntries(screens.map((screen) => [screen.route, screen.headerMode])),
    },
    navigation: {
      initialRoute: primary.route,
      keyFlowRoute: keyFlow.route,
      routes: screens.map((screen) => screen.route),
    },
    fixtures: {
      adapter: data.adapter,
      entities: data.entities,
      assetPolicy: contract.assetPolicy.media,
      dataIntentPath: data.path,
      assetManifest: 'assets/experience/manifest.json',
      viewModel: 'src/generated/experience-view-model.ts',
      recordIdentity: 'stable-primary-key',
      mediaPolicy: contract.assetPolicy.media,
      mediaManifest: 'assets/experience/manifest.json',
      mediaFields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
    },
    screens,
    buildOrder: [
      ...foundation.primitives.map((primitive) => ({ kind: 'foundation', id: primitive.component, file: primitive.file, dependsOn: [] })),
      { kind: 'screen', id: primaryScreen.id, route: primaryScreen.route, dependsOn: foundation.primitives.map((primitive) => primitive.component) },
      { kind: 'screen', id: keyFlowScreen.id, route: keyFlowScreen.route, dependsOn: [primaryScreen.id, ...foundation.primitives.map((primitive) => primitive.component)] },
      ...screens.filter((screen) => !['primary', 'key-flow'].includes(screen.role)).map((screen) => ({ kind: 'screen', id: screen.id, route: screen.route, dependsOn: [primaryScreen.id] })),
    ],
    invalidation: {
      screenDependencies: Object.fromEntries(screens.map((screen) => [screen.id, screen.role === 'supporting'
        ? ['screenContract', 'designRecipe', 'dataIntent']
        : ['experienceContract', 'screenContract', 'foundationContract', 'designRecipe', 'dataIntent']])),
      fixtureDependencies: Object.fromEntries(data.entities.map((entity) => [entity, ['experienceContract', 'dataIntent']])),
      validatorDependencies: {
        experience: ['experienceContract', 'screenContract', 'foundationContract'],
        nativeVisual: ['experienceContract', 'screenContract', 'foundationContract', 'designRecipe'],
      },
    },
  };
  pack.revision = revisionForPack(pack);
  return pack;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node compile-screen-build-pack.js --project-root <dir> [--output <path>] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const pack = compileScreenBuildPack(root);
    const output = path.resolve(root, args.output || '.tmp/screen-build-pack.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(pack, null, 2)}\n`);
    if (args.json) process.stdout.write(`${JSON.stringify({ output, revision: pack.revision }, null, 2)}\n`);
    else process.stdout.write(`Screen build pack written: ${output} (${pack.revision})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: screen build pack: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { compileScreenBuildPack, parseScreenMap, revisionForPack, sha256, stableStringify };