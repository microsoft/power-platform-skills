#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { buildNavigationManifest } = require('./compile-navigation-manifest');
const { compileScreenBuildPack } = require('./compile-screen-build-pack');
const { readDesignTokenContract } = require('./lib/design-token-contract');
const { validateRenderedLayout } = require('./lib/final-preview-browser-layout');
const {
  validatePreviewOutputIsolation,
  validateProductionAuthoringIsolation,
  validateProductionSourceIsolation,
  validateProjectSourceIsolation,
} = require('./lib/final-preview-isolation');
const { validateStructuralQuality } = require('./lib/final-preview-quality');
const { buildSharedDesignInputs } = require('./lib/shared-design-inputs');
const {
  isDescendant,
  normalizedText,
  parseHtmlDocument,
} = require('./lib/html-document-lite');
const {
  selectPreviewScreens,
} = require('./lib/product-experience-preview-selection');
const {
  CONTRACT_ARTIFACTS,
  canonicalJson,
  contractRevision,
  emitResult,
  fatal,
  finding,
  parseArgs,
  readJsonFile,
  resolveContractPath,
  sha256Hex,
} = require('./lib/product-experience-contracts');
const {
  projectScreenFacts,
  validateScenarioFacts,
} = require('./validate-fixture-scenarios');

const TOOL = 'validate-product-experience-preview';
const USAGE = 'Usage: node validate-product-experience-preview.js [--project-root <dir>] [--preview <path>] [--tokens <path>] [--signature-components <path>] [--contract-output <path>]';
const ARG_SPEC = {
  '--project-root': 'projectRoot',
  '--preview': 'preview',
  '--tokens': 'tokens',
  '--signature-components': 'signatureComponents',
  '--contract-output': 'contractOutput',
};
const PROHIBITED_VISIBLE_TEXT = [
  ['placeholder-copy', /\b(?:lorem ipsum|sample value|add details|todo|tbd)\b/i],
  ['structural-preview-copy', /\b(?:neutral structural preview|sample preview)\b/i],
];

function cssTargetCompound(selector) {
  return selector.trim().split(/\s+|>|\+|~/).filter(Boolean).at(-1) || '';
}

function compoundMatchesNode(compound, node) {
  const withoutPseudos = compound.replace(/:{1,2}[a-z-]+(?:\([^)]*\))?/gi, '');
  const tag = withoutPseudos.match(/^[a-z][a-z0-9-]*/i)?.[0]?.toLowerCase();
  if (tag && node.tag !== tag) return false;
  const id = withoutPseudos.match(/#([a-z0-9_-]+)/i)?.[1];
  if (id && node.attrs.id !== id) return false;
  const classes = [...withoutPseudos.matchAll(/\.([a-z0-9_-]+)/gi)].map((match) => match[1]);
  const nodeClasses = new Set(String(node.attrs.class || '').split(/\s+/).filter(Boolean));
  if (classes.some((className) => !nodeClasses.has(className))) return false;
  const attributes = [...withoutPseudos.matchAll(/\[([a-z0-9:_-]+)(?:\s*=\s*["']?([^\]"']+)["']?)?\]/gi)];
  for (const [, name, value] of attributes) {
    if (!Object.prototype.hasOwnProperty.call(node.attrs, name.toLowerCase())) return false;
    if (value !== undefined && node.attrs[name.toLowerCase()] !== value.trim()) return false;
  }
  return tag !== undefined || id !== undefined || classes.length > 0 || attributes.length > 0
    || withoutPseudos === '*';
}

function stylesheetHidingFindings(elements, protectedNodes) {
  const findings = [];
  const protectedWithAncestors = new Set();
  for (const node of protectedNodes.filter(Boolean)) {
    let current = node;
    while (current && current.tag !== '#document') {
      protectedWithAncestors.add(current);
      current = current.parent;
    }
  }
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const style of elements.filter((element) => element.tag === 'style')) {
    const source = style.text.replace(/\/\*[\s\S]*?\*\//g, '');
    let match;
    while ((match = rule.exec(source)) !== null) {
      if (!/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(match[2])) {
        continue;
      }
      for (const selector of match[1].split(',')) {
        if (/\[(?:hidden|aria-hidden)/i.test(selector)) continue;
        const target = cssTargetCompound(selector);
        if ([...protectedWithAncestors].some((node) => compoundMatchesNode(target, node))) {
          findings.push(selector.trim());
        }
      }
    }
  }
  return [...new Set(findings)];
}

function tokenCss(contract) {
  const colors = Object.entries(contract.colors)
    .map(([name, value]) => `  --color-${name}: ${value};`);
  const typography = contract.typography;
  return [
    ':root {',
    ...colors,
    `  --font-heading-family: ${JSON.stringify(typography.family)};`,
    `  --font-heading-size: ${typography.size}px;`,
    `  --font-heading-weight: ${typography.weight};`,
    `  --font-heading-line-height: ${typography.lineHeight};`,
    `  --font-heading-letter-spacing: ${typography.tracking}em;`,
    '}',
  ].join('\n');
}

function scenarioEvidence(screenId, facts) {
  const candidates = [];
  const add = (role, value) => {
    if (value === undefined || value === null || String(value).trim() === '') return;
    const text = String(value);
    candidates.push({
      id: `evidence-${sha256Hex(`${screenId}\0${role}\0${text}`).slice(0, 16)}`,
      role,
      value: text,
    });
  };
  add('headline', facts?.headline);
  add('supporting-text', facts?.supportingText);
  for (const [index, record] of (facts?.records || []).entries()) {
    for (const field of ['title', 'subtitle', 'meta', 'badge']) {
      add(`record-${index}-${field}`, record[field]);
    }
  }
  for (const collection of ['metrics', 'fields', 'summaryRows']) {
    for (const [index, item] of (facts?.[collection] || []).entries()) {
      add(`${collection}-${index}-label`, item.label);
      add(`${collection}-${index}-value`, item.value);
    }
  }
  for (const [index, media] of (facts?.media || []).entries()) {
    add(`media-${index}-fallback`, media.fallback);
  }
  return candidates;
}

function buildFinalPreviewContract({
  experience,
  scope,
  journey,
  compiled,
  scenario,
  navigation,
  tokenContract,
  signatureComponentsSource,
}) {
  const selected = selectPreviewScreens(compiled, journey, navigation);
  const selectedScreenIds = selected.map((screen) => screen.screenId);
  const sharedDesignInputs = buildSharedDesignInputs({
    experienceDirective: compiled.experienceDirective,
    navigation,
    tokenContract,
    signatureComponentsSource,
  });
  const contract = {
    schemaVersion: 1,
    contractType: 'product-experience-final-preview',
    authorship: 'design-system-model',
    revisions: {
      experience: contractRevision(experience),
      scope: contractRevision(scope),
      journey: contractRevision(journey),
      compiled: compiled.compiledRevision,
      scenario: scenario.scenarioRevision,
      navigation: navigation.manifestRevision,
      designTokens: tokenContract.revision,
      signatureComponents: sharedDesignInputs.signatureComponents.revision,
    },
    sharedDesignInputs,
    experienceDirective: sharedDesignInputs.experienceDirective,
    selectedScreenIds,
    navigation: sharedDesignInputs.navigation,
    designTokens: {
      colors: sharedDesignInputs.tokens.colors,
      typography: sharedDesignInputs.tokens.typography,
      css: tokenCss(tokenContract),
    },
    landmarks: {
      navigation: 'preview-navigation',
      storyboard: 'preview-storyboard',
      allScreens: 'preview-all-screens',
    },
    requirements: (scope.requirements || [])
      .filter((requirement) => requirement.disposition === 'shipping')
      .map((requirement) => ({
      requirementId: requirement.id,
      statement: requirement.statement,
      jobId: requirement.jobId || null,
      disposition: 'shipping',
    })),
    screens: selected.map((screen) => {
      const facts = projectScreenFacts(scenario, screen.screenId);
      return {
        screenId: screen.screenId,
        title: screen.title,
        pattern: screen.pattern,
        classification: screen.classification,
        packRevision: sha256Hex(canonicalJson(screen.pack)),
        identityHierarchy: screen.pack.identityHierarchy,
        firstViewport: screen.pack.firstViewport,
        signatureIntent: screen.pack.signatureInteraction,
        primaryActions: (screen.pack.primaryActions || []).map((action, index) => ({
          markerId: `${screen.screenId}:primary:${index}`,
          label: action.label,
          targetScreenId: action.targetScreenId || null,
        })),
        states: Object.entries(screen.pack.states || {}).map(([name, copy]) => ({ name, copy })),
        media: (facts?.media || []).map((asset) => ({
          key: asset.key,
          fallback: asset.fallback,
          role: screen.pack.media?.role || 'none',
        })),
        scenarioEvidence: scenarioEvidence(screen.screenId, facts),
      };
    }),
    allScreenIds: (compiled.screens || []).map((screen) => screen.screenId),
  };
  contract.contractRevision = sha256Hex(canonicalJson(contract));
  return contract;
}

function validateSources(sources) {
  const errors = [];
  const expectedCompiled = compileScreenBuildPack(sources.buildPack, sources);
  if (!expectedCompiled.ok) errors.push(...expectedCompiled.errors);
  else if (canonicalJson(sources.compiled) !== canonicalJson(expectedCompiled.compiled)) {
    errors.push(finding('stale-compiled-artifact', 'compiled screen build pack does not match current contracts'));
  }
  const expectedNavigation = buildNavigationManifest(sources.scope);
  if (canonicalJson(sources.navigation) !== canonicalJson(expectedNavigation)) {
    errors.push(finding('stale-navigation-manifest', 'navigation manifest does not match current Product Scope'));
  }
  const scenarioResult = validateScenarioFacts(sources.scenario, sources);
  if (!scenarioResult.ok) errors.push(...scenarioResult.errors);
  if (!sources.tokenContract.ok) {
    errors.push(finding(sources.tokenContract.code, sources.tokenContract.message));
  }
  if (!sources.signatureComponentsSource.trim()) {
    errors.push(finding('signature-components-empty', 'brand/signature-components.ts must not be empty'));
  }
  return errors;
}

function sameMembers(actual, expected) {
  return actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function elementsWith(elements, attribute, value = null) {
  return elements.filter((element) => (
    Object.prototype.hasOwnProperty.call(element.attrs, attribute)
      && (value === null || element.attrs[attribute] === value)
  ));
}

function validateHtml(html, expected) {
  const parsed = parseHtmlDocument(html);
  const errors = parsed.errors.map((message) => finding('preview-html-invalid', message));
  if (!parsed.hasDoctype) errors.push(finding('preview-doctype-missing', 'final preview requires <!doctype html>'));
  const findId = (id) => elementsWith(parsed.elements, 'id', id);
  const requireUnique = (id, tag) => {
    const matches = findId(id);
    if (matches.length !== 1 || matches[0].tag !== tag) {
      errors.push(finding('preview-landmark-invalid', `expected one <${tag} id="${id}"> landmark`));
      return null;
    }
    if (matches[0].hidden) errors.push(finding('preview-landmark-hidden', `${id} must be visible`));
    return matches[0];
  };

  const body = parsed.elements.find((element) => element.tag === 'body');
  if (!body
    || body.attrs['data-preview-mode'] !== 'final'
    || body.attrs['data-preview-authorship'] !== 'design-system-model') {
    errors.push(finding(
      'preview-authorship-invalid',
      'body must declare data-preview-mode="final" and data-preview-authorship="design-system-model"',
    ));
  }
  if (!body || body.attrs['data-preview-contract-revision'] !== expected.contractRevision) {
    errors.push(finding(
      'preview-contract-revision-mismatch',
      'body data-preview-contract-revision does not match current canonical artifacts',
    ));
  }
  const navigation = requireUnique(expected.landmarks.navigation, 'nav');
  const storyboard = requireUnique(expected.landmarks.storyboard, 'main');
  const allScreens = requireUnique(expected.landmarks.allScreens, 'section');

  const tokenStyles = findId('product-experience-token-contract');
  if (tokenStyles.length !== 1
    || tokenStyles[0].tag !== 'style'
    || tokenStyles[0].text.trim() !== expected.designTokens.css) {
    errors.push(finding('preview-token-css-mismatch', 'final preview must include the exact generated token CSS contract'));
  }

  const screenNodes = elementsWith(parsed.elements, 'data-preview-screen-id');
  const visibleScreenIds = screenNodes.filter((node) => !node.hidden).map(
    (node) => node.attrs['data-preview-screen-id'],
  );
  if (canonicalJson(visibleScreenIds) !== canonicalJson(expected.selectedScreenIds)) {
    errors.push(finding('preview-screen-selection-mismatch', 'visible storyboard screens do not match semantic selection order'));
  }

  for (const screen of expected.screens) {
    const screenNode = screenNodes.find((node) => (
      node.attrs['data-preview-screen-id'] === screen.screenId && !node.hidden
    ));
    if (!screenNode || (storyboard && !isDescendant(screenNode, storyboard))) {
      errors.push(finding('preview-screen-landmark-missing', `${screen.screenId} is not visible inside the storyboard`));
      continue;
    }
    if (screenNode.attrs['data-pack-revision'] !== screen.packRevision) {
      errors.push(finding('preview-pack-revision-mismatch', `${screen.screenId} does not declare its canonical pack revision`));
    }
    const signature = elementsWith(parsed.elements, 'data-signature-intent', screen.screenId)
      .find((node) => !node.hidden && (
        isDescendant(node, screenNode)
        || (allScreens && isDescendant(node, allScreens))
      ));
    const signatureText = signature ? normalizedText(signature) : '';
    if (!signature
      || !signatureText.includes(screen.signatureIntent.name)
      || !signatureText.includes(screen.signatureIntent.description)) {
      errors.push(finding('preview-signature-intent-missing', `${screen.screenId} must visibly preserve its signature intent`));
    }
    for (const action of screen.primaryActions) {
      const marker = elementsWith(parsed.elements, 'data-primary-action', action.markerId)
        .find((node) => !node.hidden && isDescendant(node, screenNode));
      if (!marker || !normalizedText(marker).includes(action.label)) {
        errors.push(finding('preview-primary-action-missing', `${screen.screenId} is missing primary action ${action.label}`));
      } else if ((marker.attrs['data-target-screen-id'] || null) !== action.targetScreenId) {
        errors.push(finding('preview-primary-action-target-mismatch', `${action.markerId} does not preserve its canonical target`));
      }
    }
    for (const state of screen.states) {
      const markerId = `${screen.screenId}:${state.name}`;
      const marker = elementsWith(parsed.elements, 'data-preview-state', markerId)
        .find((node) => !node.hidden && (
          isDescendant(node, screenNode)
          || (allScreens && isDescendant(node, allScreens))
        ));
      if (!marker || !normalizedText(marker).includes(state.copy)) {
        errors.push(finding('preview-state-missing', `${screen.screenId} is missing state ${state.name}`));
      }
    }
    for (const asset of screen.media) {
      const marker = elementsWith(parsed.elements, 'data-media-asset-key', asset.key)
        .find((node) => !node.hidden && isDescendant(node, screenNode));
      if (!marker) errors.push(finding('preview-media-missing', `${screen.screenId} is missing media ${asset.key}`));
    }
    for (const evidence of screen.scenarioEvidence) {
      const marker = elementsWith(parsed.elements, 'data-scenario-evidence-id', evidence.id)
        .find((node) => !node.hidden && (
          isDescendant(node, screenNode)
          || (allScreens && isDescendant(node, allScreens))
        ));
      if (!marker || !normalizedText(marker).includes(evidence.value)) {
        errors.push(finding('preview-scenario-evidence-missing', `${screen.screenId} is missing ${evidence.role}: ${evidence.value}`));
      }
    }
  }

  const expectedDestinations = expected.navigation.durableDestinations.map(
    (destination) => destination.destinationId,
  );
  const visibleDestinations = elementsWith(parsed.elements, 'data-navigation-destination')
    .filter((node) => !node.hidden && (!navigation || isDescendant(node, navigation)))
    .map((node) => node.attrs['data-navigation-destination']);
  if (!sameMembers(visibleDestinations, expectedDestinations)) {
    errors.push(finding('preview-navigation-mismatch', 'visible navigation destinations do not match the canonical manifest'));
  }
  for (const destination of expected.navigation.durableDestinations) {
    const marker = elementsWith(parsed.elements, 'data-navigation-destination', destination.destinationId)
      .find((node) => !node.hidden && (!navigation || isDescendant(node, navigation)));
    if (marker && !normalizedText(marker).includes(destination.label)) {
      errors.push(finding('preview-navigation-label-mismatch', `${destination.destinationId} must use label ${destination.label}`));
    }
    if (marker && (marker.attrs['data-navigation-target-path'] || null) !== destination.targetPath) {
      errors.push(finding('preview-navigation-target-mismatch', `${destination.destinationId} must target ${destination.targetPath}`));
    }
  }

  const allScreenIds = elementsWith(parsed.elements, 'data-all-screen-id')
    .filter((node) => !node.hidden && (!allScreens || isDescendant(node, allScreens)))
    .map((node) => node.attrs['data-all-screen-id']);
  if (!sameMembers(allScreenIds, expected.allScreenIds)) {
    errors.push(finding('preview-complete-graph-mismatch', 'All screens must expose the complete canonical graph'));
  }
  for (const requirement of expected.requirements) {
    const markers = elementsWith(
      parsed.elements,
      'data-requirement-id',
      requirement.requirementId,
    ).filter((node) => !node.hidden && (
      (storyboard && isDescendant(node, storyboard))
      || (allScreens && isDescendant(node, allScreens))
    ));
    if (markers.length !== 1 || !normalizedText(markers[0]).includes(requirement.statement)) {
      errors.push(finding(
        'preview-requirement-missing',
        `final preview must expose approved requirement ${requirement.requirementId}`,
      ));
    }
  }

  const visibleText = normalizedText(parsed.document);
  for (const [code, pattern] of PROHIBITED_VISIBLE_TEXT) {
    if (pattern.test(visibleText)) errors.push(finding(code, `final preview contains prohibited visible text matching ${pattern}`));
  }
  if (parsed.elements.some((element) => element.tag === 'script' && element.attrs.src)) {
    errors.push(finding('preview-external-script-forbidden', 'final preview must not load external scripts'));
  }
  if (parsed.elements.some((element) => (
    element.tag === 'link' && String(element.attrs.rel || '').toLowerCase() === 'stylesheet'
  ))) {
    errors.push(finding('preview-external-stylesheet-forbidden', 'final preview must not load external stylesheets'));
  }
  const protectedNodes = [
    navigation,
    storyboard,
    allScreens,
    ...screenNodes,
    ...[
      'data-signature-intent',
      'data-primary-action',
      'data-media-asset-key',
      'data-scenario-evidence-id',
      'data-navigation-destination',
      'data-all-screen-id',
      'data-requirement-id',
    ].flatMap((attribute) => elementsWith(parsed.elements, attribute)),
  ];
  const hiddenSelectors = stylesheetHidingFindings(parsed.elements, protectedNodes);
  if (hiddenSelectors.length > 0) {
    errors.push(finding(
      'preview-required-content-css-hidden',
      `stylesheet hides required preview content with selector(s): ${hiddenSelectors.join(', ')}`,
    ));
  }
  return { errors, parsed };
}

function loadSources(paths) {
  return {
    experience: readJsonFile(paths.experience),
    scope: readJsonFile(paths.scope),
    journey: readJsonFile(paths.journey),
    buildPack: readJsonFile(paths.buildPack),
    compiled: readJsonFile(paths.compiled),
    scenario: readJsonFile(paths.scenario),
    navigation: readJsonFile(paths.navigation),
    persistence: fs.existsSync(paths.persistence) ? readJsonFile(paths.persistence) : null,
    tokenContract: readDesignTokenContract(paths.tokens),
    signatureComponentsSource: fs.readFileSync(paths.signatureComponents, 'utf8'),
  };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function main(argv) {
  const args = parseArgs(argv, ARG_SPEC);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if ((args.unknown || []).length) return fatal(TOOL, `unknown argument(s): ${args.unknown.join(', ')}. ${USAGE}`);
  const projectRoot = path.resolve(args.projectRoot || process.cwd());
  const paths = {
    experience: resolveContractPath(projectRoot, null, CONTRACT_ARTIFACTS['product-experience']),
    scope: resolveContractPath(projectRoot, null, CONTRACT_ARTIFACTS['product-scope']),
    journey: resolveContractPath(projectRoot, null, CONTRACT_ARTIFACTS['workflow-journey']),
    buildPack: resolveContractPath(projectRoot, null, CONTRACT_ARTIFACTS['screen-build-pack']),
    compiled: resolveContractPath(projectRoot, null, CONTRACT_ARTIFACTS['compiled-screen-build-pack']),
    scenario: resolveContractPath(projectRoot, null, '.tmp/scenario-facts.json'),
    navigation: resolveContractPath(projectRoot, null, '.tmp/navigation-manifest.json'),
    persistence: resolveContractPath(projectRoot, null, '.tmp/persistence-contract.json'),
    tokens: resolveContractPath(projectRoot, args.tokens, 'brand/tokens.ts'),
    signatureComponents: resolveContractPath(
      projectRoot,
      args.signatureComponents,
      'brand/signature-components.ts',
    ),
    preview: resolveContractPath(projectRoot, args.preview, '_plan_preview.html'),
    contractOutput: args.contractOutput
      ? resolveContractPath(projectRoot, args.contractOutput, args.contractOutput)
      : null,
  };
  try {
    for (const [label, file] of Object.entries(paths)) {
      if (['preview', 'contractOutput', 'persistence', 'tokens'].includes(label)) continue;
      if (!fs.existsSync(file)) return fatal(TOOL, `missing ${label}: ${file}`);
    }
    const sources = loadSources(paths);
    const pluginRoot = path.resolve(__dirname, '..');
    const productionIsolation = validateProductionAuthoringIsolation(pluginRoot);
    const productionSourceIsolation = validateProductionSourceIsolation(pluginRoot);
    const projectIsolation = validateProjectSourceIsolation(projectRoot);
    const sourceErrors = [
      ...validateSources(sources),
      ...productionIsolation.errors,
      ...productionSourceIsolation.errors,
      ...projectIsolation.errors,
    ];
    if (sourceErrors.length) return emitResult({ ok: false, tool: TOOL, errors: sourceErrors, warnings: [] });
    const contract = buildFinalPreviewContract({
      ...sources,
      signatureComponentsSource: sources.signatureComponentsSource,
    });
    if (paths.contractOutput) {
      atomicWriteJson(paths.contractOutput, contract);
      return emitResult({
        ok: true,
        tool: TOOL,
        mode: 'contract-preparation',
        contractPath: paths.contractOutput,
        selectedScreenIds: contract.selectedScreenIds,
        contractRevision: contract.contractRevision,
        fixtureIsolation: {
          productionPromptFilesScanned: productionIsolation.scannedFiles,
          productionSourceFilesScanned: productionSourceIsolation.scannedFiles,
          projectSourceFilesScanned: projectIsolation.scannedFiles,
          forbiddenReferenceCount: productionIsolation.errors.length,
          productionTestImportCount: productionSourceIsolation.errors.length,
          forbiddenImportCount: projectIsolation.errors.length,
        },
        errors: [],
        warnings: [],
      });
    }
    if (!fs.existsSync(paths.preview)) return fatal(TOOL, `missing preview: ${paths.preview}`);
    const html = fs.readFileSync(paths.preview, 'utf8');
    const semanticValidation = validateHtml(html, contract);
    const outputIsolation = validatePreviewOutputIsolation(html);
    const structuralValidation = validateStructuralQuality(
      html,
      contract,
      semanticValidation.parsed,
    );
    const renderedLayout = semanticValidation.errors.length === 0
      ? process.env.POWER_PLATFORM_SKILLS_PREVIEW_BROWSER_LAYOUT === '0'
        ? { status: 'skipped', reason: 'browser-disabled', errors: [], viewports: [] }
        : validateRenderedLayout(html, contract)
      : {
        status: 'skipped',
        reason: 'semantic-validation-failed',
        errors: [],
        viewports: [],
      };
    const errors = [
      ...semanticValidation.errors,
      ...outputIsolation.errors,
      ...structuralValidation.errors,
      ...renderedLayout.errors,
    ];
    const warnings = renderedLayout.status === 'skipped'
      ? [finding(
        'layout-validation-skipped',
        `optional rendered-layout validation skipped: ${renderedLayout.reason}`,
      )]
      : [];
    return emitResult({
      ok: errors.length === 0,
      tool: TOOL,
      previewPath: paths.preview,
      selectedScreenIds: contract.selectedScreenIds,
      allScreenIds: contract.allScreenIds,
      scenarioRevision: contract.revisions.scenario,
      compiledRevision: contract.revisions.compiled,
      designTokenRevision: contract.revisions.designTokens,
      signatureComponentsRevision: contract.revisions.signatureComponents,
      previewContractRevision: contract.contractRevision,
      previewRevision: sha256Hex(html),
      quality: {
        semantic: { passed: semanticValidation.errors.length === 0 },
        structural: {
          passed: structuralValidation.errors.length === 0,
          metrics: structuralValidation.metrics,
        },
        renderedLayout: {
          status: renderedLayout.status,
          reason: renderedLayout.reason,
          viewports: renderedLayout.viewports,
        },
      },
      fixtureIsolation: {
        productionPromptFilesScanned: productionIsolation.scannedFiles,
        productionSourceFilesScanned: productionSourceIsolation.scannedFiles,
        projectSourceFilesScanned: projectIsolation.scannedFiles,
        forbiddenReferenceCount: productionIsolation.errors.length,
        productionTestImportCount: productionSourceIsolation.errors.length,
        forbiddenImportCount: projectIsolation.errors.length,
        fixtureMarkerCount: outputIsolation.leakedMarkers.length,
      },
      errors,
      warnings,
    });
  } catch (error) {
    return fatal(TOOL, error.message);
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  buildFinalPreviewContract,
  stylesheetHidingFindings,
  scenarioEvidence,
  tokenCss,
  validateHtml,
  validateStructuralQuality,
};