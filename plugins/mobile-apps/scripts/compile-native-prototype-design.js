#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const RECIPE_SCHEMA = require('./schema-native-prototype-design-recipe.json');
const { contractHash, foundationContract, validateExperienceContract } = require('./experience-patterns');
const { validateExperienceScreenContract } = require('./lib/experience-screen-contract');
const { validateJsonSchema } = require('./lib/json-schema-lite');
const { domainModelRevision, validatePrototypeDomainModel } = require('./lib/prototype-domain-model');
const { semanticPlanRevision, validatePrototypeSemanticPlan } = require('./lib/prototype-semantic-plan');
const { contextEnrichmentRevision } = require('./resolve-context-enrichment');
const { navigationContractRevision } = require('./resolve-navigation-contract');
const { validateNavigationContract } = require('./validate-navigation-contract');
const { validateWorkflowJourney } = require('./validate-workflow-journey');

const SOURCE_PATHS = {
  semanticPlan: '.tmp/prototype-semantic-plan.json',
  experienceContract: '.tmp/experience-contract.json',
  screenContract: '.tmp/experience-screen-contract.json',
  foundationContract: '.tmp/experience-foundation-contract.json',
  navigationContract: '.tmp/navigation-contract.json',
  domainModel: '.tmp/prototype-domain-model.json',
  contextContract: '.tmp/context-enrichment-contract.json',
  workflowJourney: '.tmp/workflow-journey-contract.json',
  executionPreflight: '.tmp/mobile-plan-execution-preflight.json',
  executionContract: '.tmp/mobile-plan-execution-contract.json',
};
const MANIFEST_PATH = '.mobile-app/prototype-design-manifest.json';
const RECIPE_PATH = 'brand/design-recipe.json';
const TOKENS_PATH = 'brand/tokens.ts';
const DESIGN_SYSTEM_PATH = 'brand/design-system.md';
const REGISTRY_PATH = 'brand/signature-components.json';
const INDEX_PATH = 'src/components/experience/index.ts';
const TAMAGUI_CONFIG_PATH = 'tamagui.config.ts';
const REQUIRED_STATE_KEYS = ['loading', 'empty', 'error', 'offline', 'partialData', 'success', 'permissionDenied', 'recovery'];
const TOKEN_GROUPS = ['color', 'typography', 'spacing', 'radius', 'elevation'];

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableHash(value) {
  return sha256(stableStringify(value));
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function requiredJson(root, relativePath, label) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${relativePath}`);
  return readJson(filePath, label);
}

function pointerEscape(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function collectLeafBindings(value, sourcePath, targetPath, bindings) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLeafBindings(item, `${sourcePath}/${index}`, `${targetPath}/${index}`, bindings));
    if (!value.length) bindings[sourcePath] = targetPath;
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectLeafBindings(child, `${sourcePath}/${pointerEscape(key)}`, `${targetPath}/${pointerEscape(key)}`, bindings);
    }
    if (!Object.keys(value).length) bindings[sourcePath] = targetPath;
    return;
  }
  bindings[sourcePath] = targetPath;
}

function sourceBindings(inputs) {
  const designIntentPaths = {};
  for (const [key, value] of Object.entries(inputs.semanticPlan.designIntent)) {
    const target = key === 'density' ? '/density/mode' : `/${pointerEscape(key)}`;
    collectLeafBindings(value, `/designIntent/${pointerEscape(key)}`, target, designIntentPaths);
  }
  const screenPaths = {};
  inputs.screenContract.screens.forEach((screen, index) => {
    for (const key of ['purpose', 'presentation', 'regions', 'firstViewport', 'header', 'primaryAction', 'media', 'states', 'qualityCriteria', 'testIds', 'forbiddenDefaults']) {
      collectLeafBindings(screen[key], `/screens/${index}/${key}`, `/screens/${index}/${key}`, screenPaths);
    }
  });
  const navigationPaths = {};
  for (const key of ['model', 'initialDestinationId', 'destinations', 'flows', 'globalRoutePolicy', 'adaptivePresentation', 'accessibility']) {
    collectLeafBindings(inputs.navigationContract[key], `/${key}`, `/navigationChrome/${key}`, navigationPaths);
  }
  const domainPaths = {};
  collectLeafBindings(inputs.domainModel.mediaPolicy, '/mediaPolicy', '/mediaStrategy/sourcePolicy', domainPaths);
  collectLeafBindings(inputs.domainModel.offlineUxIntent, '/offlineUxIntent', '/mediaStrategy/offlineIntent', domainPaths);
  const foundationPaths = {};
  inputs.foundationContract.primitives.forEach((primitive, index) => {
    collectLeafBindings(primitive, `/primitives/${index}`, `/foundationPrimitives/${index}`, foundationPaths);
  });
  return {
    semanticPlanSha256: semanticPlanRevision(inputs.semanticPlan),
    experienceContractSha256: contractHash(inputs.experienceContract),
    screenContractSha256: stableHash(inputs.screenContract),
    foundationContractSha256: stableHash(inputs.foundationContract),
    navigationContractSha256: navigationContractRevision(inputs.navigationContract),
    domainModelSha256: domainModelRevision(inputs.domainModel),
    runtimeConfigScaffoldSha256: inputs.runtimeConfigScaffoldSha256,
    designIntentPaths,
    screenPaths,
    navigationPaths,
    domainPaths,
    foundationPaths,
  };
}

function customizationRange(source) {
  const match = /^(\/\/ CUSTOMIZATION START[^\r\n]*)\r?\n[\s\S]*?^((?:\/\/ CUSTOMIZATION END)[^\r\n]*)/m.exec(source);
  if (!match) throw new Error(`/${TAMAGUI_CONFIG_PATH}: customization markers are missing`);
  return { start: match.index, end: match.index + match[0].length, startLine: match[1], endLine: match[2] };
}

function normalizedRuntimeScaffold(source) {
  const range = customizationRange(source);
  return `${source.slice(0, range.start)}${range.startLine}\n<automatic-native-design>\n${range.endLine}${source.slice(range.end)}`;
}

function isFreshRuntimeScaffold(source) {
  if (/from\s+['"]\.\/brand\/tokens['"]/.test(source)) return false;
  try {
    customizationRange(source);
  } catch {
    return false;
  }
  return /const customConfig\s*=\s*\{\s*\.\.\.defaultConfig,\s*animations,?\s*\};/s.test(source);
}

function pascalCase(value) {
  return String(value).split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function typographyFromIntent(intent) {
  const editorial = intent.headingFamily === 'platform-serif';
  return {
    displayRole: editorial ? 'editorial-display' : 'clear-emphasis',
    bodyRole: 'accessible-system-body',
    runtimeStrategy: editorial ? 'platform-safe-editorial' : 'system-native',
    headingFamily: intent.headingFamily,
    bodyFamily: intent.bodyFamily,
    monoFamily: intent.monoFamily,
    rationale: `${intent.character}. ${intent.dynamicTypeBehavior}`,
    supportsDynamicType: true,
    roles: {
      display: '$heading',
      heading: '$heading',
      title: '$heading',
      screenTitle: '$heading',
      sectionTitle: '$heading',
      cardTitle: '$heading',
      body: '$body',
      supporting: '$body',
      label: '$body',
      metadata: '$body',
      caption: '$body',
      button: '$body',
    },
    dynamicType: { enabled: true, maximumScale: 2, preserveLayout: true },
  };
}

function spacingForDensity(density) {
  if (density === 'sparse') return { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
  if (density === 'dense') return { xs: 2, sm: 6, md: 10, lg: 16, xl: 24 };
  return { xs: 4, sm: 8, md: 12, lg: 20, xl: 28 };
}

function screenById(inputs, screenId) {
  return inputs.screenContract.screens.find((screen) => screen.id === screenId);
}

function compileSignatureComponents(inputs) {
  const primitiveByMotif = new Map(inputs.foundationContract.primitives.map((primitive) => [primitive.motif, primitive]));
  const names = new Set();
  return inputs.semanticPlan.designIntent.signatureComponents.map((signature, index) => {
    const primitive = primitiveByMotif.get(signature.foundationMotifs[0]);
    const implementationName = primitive?.component || `Experience${pascalCase(signature.kind)}`;
    if (!implementationName || names.has(implementationName)) throw new Error(`/designIntent/signatureComponents/${index}/kind: component name collision for ${implementationName || signature.kind}`);
    names.add(implementationName);
    const eligibleScreens = signature.screenIds.map((id) => screenById(inputs, id));
    if (eligibleScreens.some((screen) => !screen)) throw new Error(`/designIntent/signatureComponents/${index}/screenIds: contains an unknown compiled screen`);
    return {
      ...signature,
      componentId: signature.kind,
      implementationName,
      file: primitive?.file || `src/components/experience/${implementationName}.tsx`,
      eligibleScreens: [...signature.screenIds],
      layoutPatterns: unique(eligibleScreens.map((screen) => screen.presentation.pattern)),
      foundationTestId: primitive?.testID || null,
      sourceBinding: `/designIntent/signatureComponents/${index}`,
    };
  });
}

function compileScreenRecipe(screen, designIntent, domainModel) {
  const firstRegionIds = new Set(screen.firstViewport.regionIds);
  const firstRegions = screen.regions.filter((region) => firstRegionIds.has(region.id));
  return {
    id: screen.id,
    role: screen.role,
    purpose: screen.purpose,
    presentation: screen.presentation,
    regions: screen.regions,
    firstViewport: {
      ...screen.firstViewport,
      primaryAction: screen.primaryAction,
      substantialRegionRationales: Object.fromEntries(firstRegions.map((region) => [region.id, screen.purpose])),
    },
    header: screen.header,
    primaryAction: screen.primaryAction,
    media: {
      ...screen.media,
      sourcePolicy: domainModel.mediaPolicy.mode,
      cropBehavior: screen.media.required ? 'cover-preserve-focal-region' : 'not-applicable',
      focalTreatment: screen.media.prominence,
      loadingTreatment: designIntent.stateTreatment.loading,
      failureTreatment: screen.media.fallback,
      accessibilityDescriptionSource: screen.media.altTextBinding,
    },
    states: screen.states,
    stateTreatment: designIntent.stateTreatment,
    qualityCriteria: screen.qualityCriteria,
    testIds: screen.testIds,
    forbiddenDefaults: unique([...screen.forbiddenDefaults, ...designIntent.avoid]),
  };
}

function compileRecipe(inputs) {
  const designIntent = inputs.semanticPlan.designIntent;
  const primary = inputs.screenContract.screens.find((screen) => screen.role === 'primary');
  if (!primary) throw new Error('/screens: one primary screen is required');
  const signatures = compileSignatureComponents(inputs);
  const spacingScale = spacingForDensity(designIntent.density);
  const primarySignature = signatures.find((component) => component.eligibleScreens.includes(primary.id));
  const stickyActions = inputs.screenContract.screens.filter((screen) => screen.primaryAction?.placement === 'sticky-bottom');
  const navigation = inputs.navigationContract;
  return {
    schemaVersion: 1,
    kind: 'native-prototype-design-recipe',
    sourceBindings: sourceBindings(inputs),
    rationale: designIntent.rationale,
    visualCharacter: designIntent.visualCharacter,
    contentTone: designIntent.contentTone,
    informationHierarchy: designIntent.informationHierarchy,
    firstViewportStrategy: {
      screenId: primary.id,
      ...primary.firstViewport,
      primaryAction: primary.primaryAction,
      substantialRegionRationales: Object.fromEntries(primary.firstViewport.regionIds.map((regionId) => [regionId, primary.purpose])),
    },
    typographyIntent: designIntent.typographyIntent,
    typography: typographyFromIntent(designIntent.typographyIntent),
    colorBehavior: designIntent.colorBehavior,
    density: { mode: designIntent.density, spacingScale, minimumControlSize: Math.max(44, navigation.accessibility.minimumTouchTarget) },
    shapeAndElevation: designIntent.shapeAndElevation,
    navigationChrome: {
      model: navigation.model,
      initialDestinationId: navigation.initialDestinationId,
      destinations: navigation.destinations,
      flows: navigation.flows,
      globalRoutePolicy: navigation.globalRoutePolicy,
      adaptivePresentation: navigation.adaptivePresentation,
      accessibility: navigation.accessibility,
      persistentDestinations: navigation.destinations.map((destination) => destination.id),
      tabBar: {
        visible: navigation.model === 'tabs-stack',
        safeArea: true,
        states: ['selected', 'unselected', 'badge', 'disabled', 'overflow'],
        nestedVisibility: Object.fromEntries(navigation.flows.map((flow) => [flow.id, flow.tabVisibility])),
      },
      headers: {
        byScreen: Object.fromEntries(inputs.screenContract.screens.map((screen) => [screen.id, screen.header])),
        backAffordance: 'platform-native-labelled',
        contextualActions: 'screen-contract-only',
      },
      stickyActions: {
        screenIds: stickyActions.map((screen) => screen.id),
        placement: 'above-persistent-navigation-and-safe-area',
      },
      keyboardBehavior: 'avoid-inputs-and-preserve-reachable-actions',
    },
    primaryActionTreatment: Object.fromEntries(inputs.screenContract.screens.filter((screen) => screen.primaryAction).map((screen) => [screen.id, {
      ...screen.primaryAction,
      semanticRole: 'primary-action',
      visualTreatment: 'filled-accent',
    }])),
    mediaStrategy: {
      ...designIntent.mediaStrategy,
      sourcePolicy: inputs.semanticPlan.domain.mediaPolicy,
      offlineIntent: inputs.semanticPlan.domain.offlineIntent,
      screens: Object.fromEntries(inputs.screenContract.screens.map((screen) => [screen.id, {
        ...screen.media,
        cropBehavior: screen.media.required ? 'cover-preserve-focal-region' : 'not-applicable',
        loadingTreatment: designIntent.stateTreatment.loading,
        failureTreatment: screen.media.fallback,
      }])),
    },
    signatureComponents: signatures,
    foundationPrimitives: inputs.foundationContract.primitives.map((primitive) => {
      const signature = signatures.find((candidate) => candidate.foundationMotifs.includes(primitive.motif));
      if (!signature) throw new Error(`/designIntent/signatureComponents: missing AI-owned contract for foundation motif ${primitive.motif}`);
      return { ...primitive, signatureComponentId: signature.componentId, sourceBinding: signature.sourceBinding };
    }),
    stateTreatment: designIntent.stateTreatment,
    motionIntent: designIntent.motionIntent,
    accessibilityIntent: designIntent.accessibilityIntent,
    tokenContract: {
      colorRoles: ['background', 'surface', 'surfaceElevated', 'text', 'textMuted', 'accent', 'accentText', 'selection', 'warning', 'error', 'success', 'border'],
      typographyRoles: ['display', 'screenTitle', 'sectionTitle', 'cardTitle', 'body', 'supporting', 'label', 'metadata', 'button'],
      spacingRoles: ['xs', 'sm', 'md', 'lg', 'xl'],
      radiusRoles: ['control', 'container', 'modal'],
      elevationRoles: ['flat', 'raised', 'overlay'],
    },
    screens: inputs.screenContract.screens.map((screen) => compileScreenRecipe(screen, designIntent, inputs.domainModel)),
    avoid: designIntent.avoid,
    hierarchy: {
      focalPoint: primary.firstViewport.focalPoint,
      primaryActionPlacement: primary.primaryAction?.placement || 'none',
      maxFirstViewportRegions: primary.firstViewport.maxRegions,
      regionOrder: primary.firstViewport.regionIds,
      nextContentVisible: primary.firstViewport.nextContentVisible,
      maxFeatureViewportShare: Math.max(...inputs.screenContract.screens.map((screen) => screen.firstViewport.maxFeatureViewportShare)),
    },
    actions: { primary: 'filled-accent', secondary: 'quiet-outline', destructive: 'explicit-error' },
    navigation: { silhouette: navigation.model, tabTreatment: navigation.model === 'tabs-stack' ? 'persistent-labeled' : 'not-applicable' },
    spacing: { rhythm: designIntent.density, density: designIntent.density, minimumControlSize: Math.max(44, navigation.accessibility.minimumTouchTarget) },
    mediaTreatment: {
      source: inputs.semanticPlan.domain.mediaPolicy.mode,
      delivery: inputs.semanticPlan.domain.mediaPolicy.mode === 'remote-cdn-cached' ? 'device-cached-with-bundled-fallback' : 'bundled-or-captured',
      fallback: inputs.semanticPlan.domain.mediaPolicy.requiresFallback ? 'local-asset' : 'content-preserving',
      avoidIconOnlyCriticalSurfaces: inputs.screenContract.screens.some((screen) => screen.media.required),
      aspectRatios: Object.fromEntries(inputs.screenContract.screens.map((screen) => [screen.id, screen.media.aspectRatio])),
      responsiveClamp: { enabled: true, maxViewportShare: Math.max(...inputs.screenContract.screens.map((screen) => screen.firstViewport.maxFeatureViewportShare)) },
    },
    signatureComponent: primarySignature || signatures[0],
    forbiddenDefaults: {
      global: unique([...inputs.experienceContract.forbiddenDefaults, ...designIntent.avoid]),
      byScreen: Object.fromEntries(inputs.screenContract.screens.map((screen) => [screen.id, unique([...screen.forbiddenDefaults, ...designIntent.avoid])])),
    },
  };
}

function renderRuntimeConfig(source) {
  if (!/import\s+\{\s*createTamagui\s*\}\s+from\s+['"]@tamagui\/core['"]/.test(source)
    || !/import\s+\{\s*defaultConfig\s*\}\s+from\s+['"]@tamagui\/config\/v5['"]/.test(source)
    || !/import\s+\{\s*animations\s*\}\s+from\s+['"]@tamagui\/config\/v5-rn['"]/.test(source)) {
    throw new Error(`/${TAMAGUI_CONFIG_PATH}: unsupported template imports`);
  }
  const range = customizationRange(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const body = `import { createFont, createTokens } from '@tamagui/core';
import { Platform } from 'react-native';
import { tokens as brandTokens } from './brand/tokens';

const platformSerifFamily = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' }) ?? 'serif';
const systemSansFamily = Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui' }) ?? 'system-ui';
const systemMonoFamily = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) ?? 'monospace';

function runtimeFamily(family: string) {
  if (family === 'platform-serif') return platformSerifFamily;
  if (family === 'system-sans') return systemSansFamily;
  if (family === 'system-monospace') return systemMonoFamily;
  throw new Error(\`Unsupported automatic design typography family: \${family}\`);
}

const roleSizes = {
  1: brandTokens.typography.metadata.size,
  2: brandTokens.typography.supporting.size,
  3: brandTokens.typography.label.size,
  4: brandTokens.typography.body.size,
  5: brandTokens.typography.cardTitle.size,
  6: brandTokens.typography.sectionTitle.size,
  7: brandTokens.typography.screenTitle.size,
  8: brandTokens.typography.display.size,
};
const roleLineHeights = {
  1: Math.round(brandTokens.typography.metadata.size * brandTokens.typography.metadata.lineHeight),
  2: Math.round(brandTokens.typography.supporting.size * brandTokens.typography.supporting.lineHeight),
  3: Math.round(brandTokens.typography.label.size * brandTokens.typography.label.lineHeight),
  4: Math.round(brandTokens.typography.body.size * brandTokens.typography.body.lineHeight),
  5: Math.round(brandTokens.typography.cardTitle.size * brandTokens.typography.cardTitle.lineHeight),
  6: Math.round(brandTokens.typography.sectionTitle.size * brandTokens.typography.sectionTitle.lineHeight),
  7: Math.round(brandTokens.typography.screenTitle.size * brandTokens.typography.screenTitle.lineHeight),
  8: Math.round(brandTokens.typography.display.size * brandTokens.typography.display.lineHeight),
};
const roleWeights = { 4: '400', 5: '600', 6: '600', 7: '700', 8: '700' } as const;
const headingFont = createFont({ family: runtimeFamily(brandTokens.typography.headingFamily), size: roleSizes, lineHeight: roleLineHeights, weight: roleWeights });
const bodyFont = createFont({ family: runtimeFamily(brandTokens.typography.bodyFamily), size: roleSizes, lineHeight: roleLineHeights, weight: roleWeights });
const monoFont = createFont({ family: runtimeFamily(brandTokens.typography.monoFamily), size: roleSizes, lineHeight: roleLineHeights, weight: roleWeights });

const tokens = createTokens({
  ...defaultConfig.tokens,
  space: { ...defaultConfig.tokens.space, ...brandTokens.space },
  size: { ...defaultConfig.tokens.size, ...brandTokens.size },
  radius: { ...defaultConfig.tokens.radius, ...brandTokens.radius },
  zIndex: { ...defaultConfig.tokens.zIndex, ...brandTokens.zIndex },
});

const lightTheme = {
  ...defaultConfig.themes.light,
  background: brandTokens.color.background,
  color: brandTokens.color.text,
  borderColor: brandTokens.color.border,
  placeholderColor: brandTokens.color.textMuted,
  surface: brandTokens.color.surface,
  surfaceElevated: brandTokens.color.surfaceElevated,
  text: brandTokens.color.text,
  textMuted: brandTokens.color.textMuted,
  accent: brandTokens.color.accent,
  accentText: brandTokens.color.accentText,
  selection: brandTokens.color.selection,
  warning: brandTokens.color.warning,
  error: brandTokens.color.error,
  success: brandTokens.color.success,
};
const darkTheme = {
  ...defaultConfig.themes.dark,
  accent: brandTokens.color.accent,
  accentText: brandTokens.color.accentText,
  selection: brandTokens.color.selection,
  warning: brandTokens.color.warning,
  error: brandTokens.color.error,
  success: brandTokens.color.success,
};
const customConfig = {
  ...defaultConfig,
  animations,
  tokens,
  themes: { ...defaultConfig.themes, light: lightTheme, dark: darkTheme },
  fonts: { ...defaultConfig.fonts, heading: headingFont, body: bodyFont, mono: monoFont },
};`;
  const managed = `${range.startLine}${newline}${body.replaceAll('\n', newline)}${newline}${range.endLine}`;
  return `${source.slice(0, range.start)}${managed}${source.slice(range.end)}`;
}

function renderTokens(recipe) {
  const palette = recipe.colorBehavior.palette;
  const spacing = recipe.density.spacingScale;
  const radius = recipe.shapeAndElevation.radiusScale;
  const typography = recipe.typography;
  const headingSizes = typography.runtimeStrategy === 'platform-safe-editorial'
    ? { display: 32, screenTitle: 26, sectionTitle: 22, cardTitle: 18 }
    : { display: 30, screenTitle: 24, sectionTitle: 20, cardTitle: 18 };
  const tokens = {
    color: {
      ...palette,
      bg: palette.background,
      primary: palette.accent,
      accentSoft: palette.selection,
      mediaSurface: palette.surfaceElevated,
      danger: palette.error,
      dangerText: palette.accentText,
      statusSuccess: palette.success,
      statusWarning: palette.warning,
      statusDanger: palette.error,
      statusInfo: palette.selection,
    },
    space: { ...spacing, '2xl': spacing.xl + spacing.sm, '3xl': spacing.xl + spacing.lg, '4xl': spacing.xl * 2 },
    size: {
      control: recipe.density.minimumControlSize,
      buttonHeight: Math.max(48, recipe.density.minimumControlSize),
      inputHeight: Math.max(48, recipe.density.minimumControlSize),
      listRowHeight: recipe.density.mode === 'dense' ? 56 : recipe.density.mode === 'sparse' ? 72 : 64,
      borderHairline: 1,
      icon: 24,
      iconSize: 24,
      avatarSm: 32,
      avatarMd: 40,
      avatarLg: 56,
    },
    radius: { ...radius, sm: radius.control, md: radius.container, lg: radius.modal, full: 9999 },
    elevation: { flat: 0, raised: 2, overlay: 8 },
    zIndex: { content: 0, sticky: 10, overlay: 20, modal: 30 },
    typography: {
      runtimeStrategy: typography.runtimeStrategy,
      headingFamily: typography.headingFamily,
      bodyFamily: typography.bodyFamily,
      monoFamily: typography.monoFamily,
      rationale: typography.rationale,
      supportsDynamicType: true,
      display: { family: typography.headingFamily, size: headingSizes.display, weight: '700', lineHeight: 1.2, tracking: 0 },
      screenTitle: { family: typography.headingFamily, size: headingSizes.screenTitle, weight: '700', lineHeight: 1.2, tracking: 0 },
      sectionTitle: { family: typography.headingFamily, size: headingSizes.sectionTitle, weight: '600', lineHeight: 1.25, tracking: 0 },
      cardTitle: { family: typography.headingFamily, size: headingSizes.cardTitle, weight: '600', lineHeight: 1.3, tracking: 0 },
      body: { family: typography.bodyFamily, size: 16, weight: '400', lineHeight: 1.5, tracking: 0 },
      supporting: { family: typography.bodyFamily, size: 14, weight: '400', lineHeight: 1.4, tracking: 0 },
      label: { family: typography.bodyFamily, size: 14, weight: '600', lineHeight: 1.35, tracking: 0 },
      metadata: { family: typography.bodyFamily, size: 12, weight: '500', lineHeight: 1.3, tracking: 0 },
      button: { family: typography.bodyFamily, size: 16, weight: '600', lineHeight: 1.25, tracking: 0 },
      heading: { family: typography.headingFamily, size: headingSizes.sectionTitle, weight: '600', lineHeight: 1.25, tracking: 0 },
      title: { family: typography.headingFamily, size: headingSizes.cardTitle, weight: '600', lineHeight: 1.3, tracking: 0 },
      bodySm: { family: typography.bodyFamily, size: 14, weight: '400', lineHeight: 1.4, tracking: 0 },
      caption: { family: typography.bodyFamily, size: 12, weight: '500', lineHeight: 1.3, tracking: 0 },
      mono: { family: typography.monoFamily, size: 14, weight: '400', lineHeight: 1.4, tracking: 0 },
    },
  };
  const bindings = {
    color: '/colorBehavior/palette',
    space: '/density/spacingScale',
    size: '/density/minimumControlSize',
    radius: '/shapeAndElevation/radiusScale',
    elevation: '/shapeAndElevation/elevationStrategy',
    zIndex: '/navigationChrome',
    typography: '/typographyIntent',
  };
  return [
    '// Generated by the native prototype design compiler. Do not hand-edit.',
    `export const tokenSourceBindings = ${JSON.stringify(bindings, null, 2)} as const;`,
    '',
    `export const tokens = ${JSON.stringify(tokens, null, 2)} as const;`,
    '',
    'export type BrandTokens = typeof tokens;',
    '',
  ].join('\n');
}

function renderComponent(component) {
  const variantType = component.variants.map((value) => JSON.stringify(value)).join(' | ');
  const stateType = component.states.map((value) => JSON.stringify(value)).join(' | ');
  const props = component.requiredContent.map((property) => `  ${property}: ReactNode;`).join('\n');
  const fields = component.requiredContent.map((property, index) => {
    const marker = index === 0 && component.testId !== component.foundationTestId ? ` testID=${JSON.stringify(component.testId)}` : '';
    return `      <Text${marker} fontFamily=${index === 0 ? '"$heading"' : '"$body"'} color=${index === 0 ? '"$text"' : '"$textMuted"'}>{${property}}</Text>`;
  }).join('\n');
  const destructured = [...component.requiredContent, 'accessibilityLabel', `variant = ${JSON.stringify(component.variants[0])}`, `state = ${JSON.stringify(component.states[0])}`, 'children'].join(', ');
  const rootTestId = component.foundationTestId || component.testId;
  return `import type { ReactNode } from 'react';
import { Text, YStack } from 'tamagui';
import { tokens } from '../../../brand/tokens';

export interface ${component.implementationName}Props {
${props}
  accessibilityLabel: string;
  variant?: ${variantType};
  state?: ${stateType};
  children?: ReactNode;
}

export function ${component.implementationName}({ ${destructured} }: ${component.implementationName}Props) {
  return (
    <YStack
      testID=${JSON.stringify(rootTestId)}
      accessibilityRole="summary"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint=${JSON.stringify(component.accessibilitySemantics)}
      accessibilityValue={{ text: \`\${variant}; \${state}\` }}
      style={{
        backgroundColor: tokens.color.surface,
        borderColor: tokens.color.border,
        borderWidth: tokens.size.borderHairline,
        borderRadius: tokens.radius.container,
        gap: tokens.space.sm,
        padding: tokens.space.md,
      }}
    >
    ${component.mediaDependencies.length ? '      {children}\n' : ''}${fields.replaceAll('color="$text"', 'color={tokens.color.text}').replaceAll('color="$textMuted"', 'color={tokens.color.textMuted}')}
${component.mediaDependencies.length ? '' : '      {children}\n'}    </YStack>
  );
}
`;
}

function renderRegistry(recipe) {
  return {
    schemaVersion: 1,
    kind: 'native-prototype-signature-registry',
    recipeSha256: stableHash(recipe),
    tokenPath: TOKENS_PATH,
    components: recipe.signatureComponents,
    foundationPrimitives: recipe.foundationPrimitives,
  };
}

function renderIndex(recipe) {
  return `${recipe.signatureComponents.slice().sort((left, right) => left.implementationName.localeCompare(right.implementationName))
    .map((component) => `export { ${component.implementationName} } from './${component.implementationName}';\nexport type { ${component.implementationName}Props } from './${component.implementationName}';`)
    .join('\n')}\n`;
}

function renderDesignSystem(recipe) {
  const palette = Object.entries(recipe.colorBehavior.palette).map(([name, value]) => `| ${name} | ${value} |`).join('\n');
  const primitives = recipe.foundationPrimitives.map((primitive) => `| ${primitive.motif} | ${primitive.component} | ${primitive.file} | ${primitive.testID} |`).join('\n');
  const signatures = recipe.signatureComponents.map((component) => `| ${component.componentId} | ${component.implementationName} | ${component.eligibleScreens.join(', ')} | ${component.testId} |`).join('\n');
  const screens = recipe.screens.map((screen) => `| ${screen.id} | ${screen.presentation.pattern} | ${screen.firstViewport.focalPoint} | ${screen.primaryAction?.label || 'none'} |`).join('\n');
  return `# Native Prototype Design System

Direction: ${recipe.visualCharacter}

## Rationale

${recipe.rationale}

## Content Tone

${recipe.contentTone}

## Palette

| Role | Value |
|---|---|
${palette}

## Typography

- Intent: ${recipe.typographyIntent.character}
- Heading family: ${recipe.typography.headingFamily}
- Body family: ${recipe.typography.bodyFamily}
- Dynamic Type: ${recipe.typographyIntent.dynamicTypeBehavior}

## Composition

| Screen | Pattern | Focal point | Primary action |
|---|---|---|---|
${screens}

## Product Experience Primitives

| Motif | Component | File | Runtime marker |
|---|---|---|---|
${primitives}

## Signature Components

| ID | Component | Eligible screens | Test ID |
|---|---|---|---|
${signatures}

## States

${REQUIRED_STATE_KEYS.map((key) => `- ${key}: ${recipe.stateTreatment[key]}`).join('\n')}

## Motion

${recipe.motionIntent.principles.map((principle) => `- ${principle}`).join('\n')}
- Reduced motion: ${recipe.motionIntent.reducedMotionBehavior}

## Accessibility

${Object.entries(recipe.accessibilityIntent).map(([key, value]) => `- ${key}: ${value}`).join('\n')}

## Negatives

${recipe.avoid.map((item) => `- ${item}`).join('\n')}

## Provenance

- Semantic plan: ${recipe.sourceBindings.semanticPlanSha256}
- Experience contract: ${recipe.sourceBindings.experienceContractSha256}
- Screen contract: ${recipe.sourceBindings.screenContractSha256}
- Navigation contract: ${recipe.sourceBindings.navigationContractSha256}
`;
}

function hexToRgb(hex) {
  const value = hex.slice(1);
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function luminance(hex) {
  const channels = hexToRgb(hex).map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(left, right) {
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function validateRecipe(recipe, inputs) {
  const errors = validateJsonSchema(recipe, RECIPE_SCHEMA);
  const expectedBindings = sourceBindings(inputs);
  if (stableStringify(recipe.sourceBindings) !== stableStringify(expectedBindings)) errors.push('/sourceBindings: stale or incomplete source bindings');
  for (const [sourcePath, targetPath] of Object.entries(recipe.sourceBindings?.designIntentPaths || {})) {
    if (typeof targetPath !== 'string' || !targetPath.startsWith('/')) errors.push(`/sourceBindings/designIntentPaths/${pointerEscape(sourcePath)}: invalid target path`);
  }
  const palette = recipe.colorBehavior?.palette || {};
  for (const [foreground, background, label] of [
    ['text', 'background', 'text/background'],
    ['text', 'surface', 'text/surface'],
    ['textMuted', 'background', 'muted/background'],
    ['accentText', 'accent', 'accent text/accent'],
  ]) {
    if (palette[foreground] && palette[background] && contrastRatio(palette[foreground], palette[background]) < 4.5) errors.push(`/colorBehavior/palette: ${label} contrast must be at least 4.5:1`);
  }
  if (new Set(['accent', 'selection', 'warning', 'error', 'success'].map((key) => palette[key])).size < 5) errors.push('/colorBehavior/palette: accent, selection, warning, error, and success must be distinct');
  if (!REQUIRED_STATE_KEYS.every((key) => typeof recipe.stateTreatment?.[key] === 'string')) errors.push('/stateTreatment: all required native states must retain the selected hierarchy');
  if (recipe.signatureComponents?.some((component) => /^(?:card|list|button|header|form)$/i.test(component.componentId))) errors.push('/signatureComponents: generic wrappers cannot be the only product signatures');
  const componentNames = recipe.signatureComponents?.map((component) => component.implementationName) || [];
  if (new Set(componentNames).size !== componentNames.length) errors.push('/signatureComponents: implementation names must be unique');
  for (const component of recipe.signatureComponents || []) {
    if (!component.requiredContent?.length) errors.push(`/signatureComponents/${component.componentId}/requiredContent: at least one field is required`);
    if (!component.variants?.length || !component.states?.length) errors.push(`/signatureComponents/${component.componentId}: variants and states are required`);
    if (!component.tokenDependencies?.every((group) => TOKEN_GROUPS.includes(group))) errors.push(`/signatureComponents/${component.componentId}/tokenDependencies: unknown token group`);
  }
  for (const screen of recipe.screens || []) {
    if (!screen.firstViewport?.regionIds?.length || screen.firstViewport.regionIds.length > screen.firstViewport.maxRegions) errors.push(`/screens/${screen.id}/firstViewport: region budget is invalid`);
    if (screen.primaryAction && stableStringify(recipe.primaryActionTreatment?.[screen.id]?.id) !== stableStringify(screen.primaryAction.id)) errors.push(`/primaryActionTreatment/${screen.id}: action identity drift`);
  }
  const offline = inputs.semanticPlan.domain.offlineIntent.connectivity !== 'network-optional';
  const requiredMedia = inputs.screenContract.screens.some((screen) => screen.media.required);
  const remoteMedia = ['remote-cdn-cached', 'remote-allowed'].includes(inputs.domainModel.mediaPolicy.mode);
  if (remoteMedia && recipe.mediaStrategy?.licensingIntent !== 'approved-remote-source') errors.push('/mediaStrategy/licensingIntent: remote media requires explicit approved-source authorization');
  if (offline && requiredMedia && inputs.domainModel.mediaPolicy.mode === 'remote-allowed') errors.push('/mediaStrategy/sourcePolicy/mode: offline-required media cannot be remote-only');
  if (offline && requiredMedia && inputs.domainModel.mediaPolicy.mode === 'remote-cdn-cached' && !inputs.domainModel.mediaPolicy.requiresFallback) errors.push('/mediaStrategy/sourcePolicy/requiresFallback: offline cached media requires a local fallback');
  if (recipe.navigationChrome?.model !== inputs.navigationContract.model) errors.push('/navigationChrome/model: does not match the resolved Navigation Contract');
  if (recipe.navigationChrome?.tabBar?.visible !== (inputs.navigationContract.model === 'tabs-stack')) errors.push('/navigationChrome/tabBar/visible: does not match the resolved Navigation Contract');
  if (recipe.density?.minimumControlSize < inputs.navigationContract.accessibility.minimumTouchTarget) errors.push('/density/minimumControlSize: smaller than Navigation Contract accessibility target');
  return errors;
}

function validateInputs(inputs, briefText, packageJson) {
  const errors = validateExperienceContract(inputs.experienceContract);
  const semantic = validatePrototypeSemanticPlan(inputs.semanticPlan, {
    experienceContract: inputs.experienceContract,
    contextContract: inputs.contextContract,
    workflowJourney: inputs.workflowJourney,
    executionPreflight: inputs.executionPreflight,
    foundationContract: inputs.foundationContract,
  });
  errors.push(...semantic.errors);
  errors.push(...validateExperienceScreenContract(inputs.screenContract, inputs.experienceContract, {
    dataContract: inputs.domainModel,
    executionContract: inputs.executionContract,
    contextContract: inputs.contextContract,
    navigationContract: inputs.navigationContract,
  }));
  const domain = validatePrototypeDomainModel(inputs.domainModel, {
    experienceContractSha256: contractHash(inputs.experienceContract),
    contextEnrichmentSha256: contextEnrichmentRevision(inputs.contextContract),
  });
  errors.push(...domain.errors);
  const journey = validateWorkflowJourney(inputs.workflowJourney, {
    briefText,
    experienceContract: inputs.experienceContract,
    contextContract: inputs.contextContract,
    screenContract: inputs.screenContract,
    domainModel: inputs.domainModel,
  });
  errors.push(...journey.errors);
  const navigation = validateNavigationContract(inputs.navigationContract, {
    experienceContract: inputs.experienceContract,
    workflowJourney: inputs.workflowJourney,
    screenContract: inputs.screenContract,
  });
  errors.push(...navigation.errors);
  if (!packageJson || typeof packageJson !== 'object') errors.push('/package.json: package manifest is required');
  if (stableStringify(inputs.foundationContract) !== stableStringify(foundationContract(inputs.experienceContract))) errors.push('/foundationContract: does not match the canonical Experience Contract derivation');
  if (errors.length) throw new Error(`invalid automatic design inputs: ${errors.join('; ')}`);
}

function readInputs(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const inputs = Object.fromEntries(Object.entries(SOURCE_PATHS).map(([key, relativePath]) => [key, requiredJson(root, relativePath, key)]));
  const briefPath = fs.existsSync(path.join(root, '.tmp', 'experience-brief.md')) ? path.join(root, '.tmp', 'experience-brief.md') : path.join(root, 'brief.md');
  if (!fs.existsSync(briefPath)) throw new Error('Confirmed brief is missing: brief.md');
  const packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error('Package manifest is missing: package.json');
  const briefText = fs.readFileSync(briefPath, 'utf8');
  const packageJson = readJson(packagePath, 'Package manifest');
  const runtimeConfigPath = path.join(root, TAMAGUI_CONFIG_PATH);
  if (!fs.existsSync(runtimeConfigPath)) throw new Error(`Runtime design config is missing: ${TAMAGUI_CONFIG_PATH}`);
  inputs.runtimeConfigSource = fs.readFileSync(runtimeConfigPath, 'utf8');
  inputs.runtimeConfigScaffoldSha256 = sha256(normalizedRuntimeScaffold(inputs.runtimeConfigSource));
  validateInputs(inputs, briefText, packageJson);
  return { root, inputs, briefText, packageJson };
}

function compileArtifacts(inputs) {
  const recipe = compileRecipe(inputs);
  const errors = validateRecipe(recipe, inputs);
  if (errors.length) throw new Error(`invalid native prototype design recipe: ${errors.join('; ')}`);
  const registry = renderRegistry(recipe);
  const files = {
    [RECIPE_PATH]: `${JSON.stringify(recipe, null, 2)}\n`,
    [TOKENS_PATH]: renderTokens(recipe),
    [DESIGN_SYSTEM_PATH]: renderDesignSystem(recipe),
    [REGISTRY_PATH]: `${JSON.stringify(registry, null, 2)}\n`,
    [INDEX_PATH]: renderIndex(recipe),
    [TAMAGUI_CONFIG_PATH]: renderRuntimeConfig(inputs.runtimeConfigSource),
  };
  for (const component of recipe.signatureComponents) files[component.file] = renderComponent(component);
  return { recipe, registry, files };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function safeTarget(root, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw new Error(`unsafe design output path: ${relativePath}`);
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target)) throw new Error(`design output escapes project root: ${relativePath}`);
  let cursor = root;
  for (const part of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`design output contains a symlink: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) throw new Error(`design output must be a regular file: ${relativePath}`);
  return target;
}

function assertOwnedOutputs(root, files) {
  const manifestFile = path.join(root, MANIFEST_PATH);
  const previous = fs.existsSync(manifestFile) ? readJson(manifestFile, 'Existing prototype design manifest') : null;
  const owned = new Map((previous?.outputs || []).map((entry) => [entry.path, entry.sha256]));
  for (const relativePath of Object.keys(files)) {
    const target = path.join(root, relativePath);
    if (!fs.existsSync(target)) continue;
    const expected = owned.get(relativePath);
    if (relativePath === TAMAGUI_CONFIG_PATH && !expected && isFreshRuntimeScaffold(fs.readFileSync(target, 'utf8'))) continue;
    if (!expected) throw new Error(`refusing to overwrite unowned design output: ${relativePath}`);
    if (sha256(fs.readFileSync(target)) !== expected) throw new Error(`refusing to overwrite modified design output: ${relativePath}`);
  }
  return previous;
}

function transactionalWrite(root, files, previousManifest) {
  const outputEntries = Object.entries(files).map(([relativePath, content]) => ({ path: relativePath, sha256: sha256(content) }));
  const recipe = JSON.parse(files[RECIPE_PATH]);
  const manifest = {
    schemaVersion: 1,
    kind: 'native-prototype-design-manifest',
    sourceBindings: recipe.sourceBindings,
    outputs: outputEntries,
  };
  const allFiles = { ...files, [MANIFEST_PATH]: `${JSON.stringify(manifest, null, 2)}\n` };
  const stalePaths = (previousManifest?.outputs || []).map((entry) => entry.path).filter((relativePath) => !Object.prototype.hasOwnProperty.call(files, relativePath));
  const stages = [];
  const removals = [];
  try {
    for (const [relativePath, content] of Object.entries(allFiles)) {
      const target = safeTarget(root, relativePath);
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(temp, content, { flag: 'wx' });
      stages.push({ target, temp, backup: null, written: false });
    }
    for (const relativePath of stalePaths) {
      const target = safeTarget(root, relativePath);
      if (!fs.existsSync(target)) continue;
      const previous = previousManifest.outputs.find((entry) => entry.path === relativePath);
      if (!previous || sha256(fs.readFileSync(target)) !== previous.sha256) throw new Error(`refusing to remove modified stale design output: ${relativePath}`);
      const backup = `${target}.${process.pid}.${Date.now()}.backup`;
      fs.renameSync(target, backup);
      removals.push({ target, backup });
    }
    for (const stage of stages) {
      if (!fs.existsSync(stage.target)) continue;
      stage.backup = `${stage.target}.${process.pid}.${Date.now()}.backup`;
      fs.renameSync(stage.target, stage.backup);
    }
    for (const stage of stages) {
      fs.renameSync(stage.temp, stage.target);
      stage.written = true;
    }
    for (const stage of stages) if (stage.backup) fs.rmSync(stage.backup, { force: true });
    for (const removal of removals) fs.rmSync(removal.backup, { force: true });
  } catch (error) {
    for (const stage of [...stages].reverse()) {
      if (stage.written) fs.rmSync(stage.target, { force: true });
      if (stage.backup && fs.existsSync(stage.backup)) fs.renameSync(stage.backup, stage.target);
      fs.rmSync(stage.temp, { force: true });
    }
    for (const removal of [...removals].reverse()) if (fs.existsSync(removal.backup)) fs.renameSync(removal.backup, removal.target);
    throw error;
  }
  return manifest;
}

function compileNativePrototypeDesign(projectRoot) {
  const { root, inputs } = readInputs(projectRoot);
  const compiled = compileArtifacts(inputs);
  const previous = assertOwnedOutputs(root, compiled.files);
  const manifest = transactionalWrite(root, compiled.files, previous);
  return { ...compiled, manifest };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node compile-native-prototype-design.js --project-root <dir> [--json]\n');
    return 2;
  }
  try {
    const result = compileNativePrototypeDesign(args.projectRoot);
    const response = { status: 'compiled', recipeSha256: stableHash(result.recipe), outputs: result.manifest.outputs.map((entry) => entry.path) };
    process.stdout.write(`${args.json ? JSON.stringify(response, null, 2) : `Native prototype design compiled (${response.recipeSha256}).`}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: native prototype design: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  DESIGN_SYSTEM_PATH,
  INDEX_PATH,
  MANIFEST_PATH,
  RECIPE_PATH,
  REGISTRY_PATH,
  SOURCE_PATHS,
  TAMAGUI_CONFIG_PATH,
  TOKENS_PATH,
  compileArtifacts,
  compileNativePrototypeDesign,
  compileRecipe,
  contrastRatio,
  readInputs,
  renderComponent,
  renderDesignSystem,
  renderIndex,
  renderRegistry,
  renderRuntimeConfig,
  renderTokens,
  sha256,
  sourceBindings,
  stableHash,
  stableStringify,
  validateRecipe,
};