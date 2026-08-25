#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contractHash, validateExperienceContract } = require('./experience-patterns');
const { normalizeScreenContract, validateExperienceScreenContract } = require('./lib/experience-screen-contract');

function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) { throw new Error(`${label} is invalid JSON: ${error.message}`); }
}

function typographyRecipe(visualCharacter) {
  const editorial = ['quiet-editorial', 'minimal-refined'].includes(visualCharacter);
  if (editorial) {
    return {
      displayRole: 'editorial-display',
      bodyRole: 'accessible-system-body',
      runtimeStrategy: 'platform-safe-editorial',
      headingFamily: 'platform-serif',
      bodyFamily: 'system-sans',
      monoFamily: 'system-monospace',
      rationale: 'Use a platform-safe serif for display hierarchy and the native system sans for controls and prose; no font download is required.',
      supportsDynamicType: true,
      roles: { display: '$heading', heading: '$heading', title: '$heading', body: '$body', label: '$body', caption: '$body' },
      dynamicType: { enabled: true, maximumScale: 2, preserveLayout: true },
    };
  }
  return {
    displayRole: 'clear-emphasis',
    bodyRole: 'accessible-system-body',
    runtimeStrategy: 'system-native',
    headingFamily: 'system-sans',
    bodyFamily: 'system-sans',
    monoFamily: 'system-monospace',
    rationale: `The ${visualCharacter} direction prioritizes native legibility and weight/scale contrast over a decorative display family.`,
    supportsDynamicType: true,
    roles: { display: '$heading', heading: '$heading', title: '$heading', body: '$body', label: '$body', caption: '$body' },
    dynamicType: { enabled: true, maximumScale: 2, preserveLayout: true },
  };
}

function resolveDesignRecipe(contract, screenContract, brandContext = null, context = {}) {
  const contractIssues = validateExperienceContract(contract);
  if (contractIssues.length) throw new Error(`Experience contract is invalid: ${contractIssues.join('; ')}`);
  const screenIssues = validateExperienceScreenContract(screenContract, contract, context);
  if (screenIssues.length) throw new Error(`Experience screen contract is invalid: ${screenIssues.join('; ')}`);
  const screens = normalizeScreenContract(screenContract, contract);
  const character = contract.visualCharacter;
  const composition = contract.visualCompositionIntent;
  const quiet = ['quiet-editorial', 'minimal-refined'].includes(character);
  return {
    schemaVersion: 1,
    experienceContractSha256: contractHash(contract),
    paletteStrategy: brandContext?.palette ? 'brand-provided' : 'prompt-inferred-original',
    visualCharacter: character,
    typography: typographyRecipe(character),
    shape: {
      cornerCharacter: quiet ? 'restrained' : 'friendly',
      elevationCharacter: quiet ? 'low-contrast-layering' : 'focused-elevation',
      borderCharacter: quiet ? 'hairline' : 'defined',
      depthTreatment: quiet ? 'surface-separation' : 'focused-shadow',
    },
    colorHierarchy: {
      canvas: '$background', surface: '$surface', elevatedSurface: '$surfaceElevated', accent: '$accent', critical: '$danger',
      contrastPairs: [['$background', '$text'], ['$surface', '$text'], ['$accent', '$accentText'], ['$danger', '$dangerText']],
    },
    spacing: { rhythm: quiet ? 'measured' : 'active', density: composition.density, minimumControlSize: 44 },
    mediaTreatment: {
      source: contract.mediaIntent?.source || (contract.assetPolicy.media === 'remote-cdn-cached' ? 'approved-cdn' : 'bundled'),
      delivery: contract.mediaIntent?.delivery || (contract.assetPolicy.media === 'remote-cdn-cached' ? 'device-cached' : 'bundled'),
      fallback: contract.mediaIntent?.fallback || 'code-native-illustration',
      avoidIconOnlyCriticalSurfaces: contract.mediaIntent?.criticality === 'required',
      aspectRatios: { hero: '16:9', detail: '1:1', collection: '4:3' },
      responsiveClamp: { enabled: true, maxViewportShare: composition.maxFeatureViewportShare },
    },
    hierarchy: {
      focalPoint: contract.firstViewport.focalPoint,
      primaryActionPlacement: contract.presentationIntent?.primaryActionPlacement || 'inline',
      maxFirstViewportRegions: contract.presentationIntent?.maxFirstViewportRegions || 4,
      regionOrder: composition.regionOrder,
      nextContentVisible: composition.nextContentVisible,
      maxFeatureViewportShare: composition.maxFeatureViewportShare,
    },
    actions: { primary: 'filled-accent', secondary: 'quiet-outline', destructive: 'explicit-danger' },
    navigation: {
      silhouette: context.navigationContract?.model || composition.navigationSilhouette,
      tabTreatment: (context.navigationContract?.model || composition.navigationSilhouette) === 'tabs-stack' ? 'persistent-labeled' : 'not-applicable',
    },
    icons: { family: 'Ionicons', strokeTreatment: 'consistent-optical-weight', criticalActionsRequireLabels: true },
    signatureComponent: { ...composition.signatureComponent, construction: `Compose ${composition.signatureComponent.kind} from semantic tokens and task-owned content; do not substitute a generic card.` },
    contextTreatment: {
      mode: context.contextContract?.contextMode || 'none',
      placement: context.contextContract?.displayContext?.some((entry) => entry.placementIntent === 'primary-screen-context-rail') ? 'compact-context-rail' : 'none',
      mustRemainSupporting: true,
    },
    responsive: { longCopy: 'wrap-without-clipping', rtl: 'logical-order-and-edges', keyboard: 'avoid-active-inputs', reducedMotion: 'disable-nonessential-motion' },
    tokenReferences: {
      colors: 'brand/tokens.ts#color', typography: 'brand/tokens.ts#typography', spacing: 'brand/tokens.ts#spacing', radii: 'brand/tokens.ts#radius',
    },
    signatureComponents: contract.signatureMotifs,
    screens: screens.map((screen) => ({
      id: screen.id,
      pattern: screen.presentation.pattern,
      density: screen.presentation.density,
      mediaRequired: screen.media.required,
      actionPlacement: screen.primaryAction?.placement || 'none',
    })),
    qualityCriteria: [
      'The first viewport has one obvious focal point and one visible primary action.',
      'Required media resolves to content imagery or a deliberate code-native illustration, never a generic icon placeholder.',
      'The runtime consumes the recipe typography through $heading/$body/$mono roles without disabling Dynamic Type.',
      'Headers, sticky actions, safe areas, and large text do not overlap or clip.',
    ],
    forbiddenDefaults: {
      global: contract.forbiddenDefaults,
      byScreen: Object.fromEntries(screens.map((screen) => [screen.id, screen.forbiddenDefaults])),
    },
  };
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
    process.stderr.write('Usage: node resolve-design-recipe.js --project-root <dir> [--output brand/design-recipe.json] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const contract = readJson(path.join(root, '.tmp', 'experience-contract.json'), 'Experience contract');
    const screenContract = readJson(path.join(root, '.tmp', 'experience-screen-contract.json'), 'Experience screen contract');
    const brandPaths = [path.join(root, '.tmp', 'brand-context.json'), path.join(root, 'brand', 'brand-context.json')];
    const brandPath = brandPaths.find((candidate) => fs.existsSync(candidate));
    const domainPath = path.join(root, '.tmp', 'prototype-domain-model.json');
    const schemaPath = path.join(root, '.tmp', 'dataverse-schema-contract.json');
    const executionPath = path.join(root, '.tmp', 'mobile-plan-execution-contract.json');
    const contextPath = path.join(root, '.tmp', 'context-enrichment-contract.json');
    const dataContract = fs.existsSync(domainPath)
      ? readJson(domainPath, 'Prototype domain model')
      : fs.existsSync(schemaPath) ? readJson(schemaPath, 'Dataverse schema contract') : null;
    const executionContract = fs.existsSync(executionPath) ? readJson(executionPath, 'Mobile plan execution contract') : null;
    const contextContract = fs.existsSync(contextPath) ? readJson(contextPath, 'Context Enrichment Contract') : null;
    const recipe = resolveDesignRecipe(contract, screenContract, brandPath ? readJson(brandPath, 'Brand context') : null, { dataContract, executionContract, contextContract });
    const output = path.resolve(root, args.output || 'brand/design-recipe.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(recipe, null, 2)}\n`);
    if (args.json) process.stdout.write(`${JSON.stringify({ output, recipe }, null, 2)}\n`);
    else process.stdout.write(`Design recipe written: ${output}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: design recipe: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseArgs, resolveDesignRecipe, typographyRecipe };
