#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REQUIRED_STATES } = require('./lib/experience-screen-contract');
const { validateScreenSourceContract } = require('./lib/screen-source-contract');

function validateWaveDag(waves, issues) {
  const byId = new Map();
  for (const wave of waves) {
    if (!wave?.id || byId.has(wave.id)) issues.push({ rule: 'duplicate-wave', message: `Builder wave id is missing or duplicated: ${wave?.id || '<missing>'}.` });
    else byId.set(wave.id, wave);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      issues.push({ rule: 'wave-cycle', message: `Builder waves contain a dependency cycle at ${id}.` });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const wave = byId.get(id);
    for (const dependency of wave?.dependsOn || []) {
      if (!byId.has(dependency)) issues.push({ rule: 'unknown-wave-dependency', message: `Builder wave ${id} depends on unknown wave ${dependency}.` });
      else visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
}

function validateScreenComposition(pack, options = {}) {
  const issues = [];
  if (!pack || pack.schemaVersion !== 2) return [{ rule: 'invalid-schema-version', message: 'Screen composition validation requires build-pack schemaVersion 2.' }];
  const screens = Array.isArray(pack.screens) ? pack.screens : [];
  const screenIds = new Set(screens.map((screen) => screen.id));
  for (const screen of screens) {
    const label = screen.route || screen.id || '<unknown>';
    if (!screen.presentation?.pattern || !screen.presentation?.density || !Array.isArray(screen.presentation?.hierarchy) || screen.presentation.hierarchy.length < 2) {
      issues.push({ rule: 'missing-presentation-contract', message: `Screen ${label} lacks pattern, density, or ordered hierarchy.` });
    }
    if (screen.contractSource === 'structured' && screen.presentation?.pattern === 'custom') {
      issues.push({ rule: 'generic-supporting-fallback', message: `Structured screen ${label} must choose a concrete presentation instead of custom fallback.` });
    }
    if (!Array.isArray(screen.regions) || !screen.regions.length || !Array.isArray(screen.firstViewport?.regionIds) || !screen.firstViewport.regionIds.length) {
      issues.push({ rule: 'missing-region-contract', message: `Screen ${label} lacks regions or a first-viewport composition.` });
    } else {
      const firstRegionIds = screen.regions.filter((region) => region.viewport === 'first').map((region) => region.id);
      const declaredFirstIds = screen.firstViewport.regionIds;
      if (declaredFirstIds.some((id) => !firstRegionIds.includes(id)) || firstRegionIds.some((id) => !declaredFirstIds.includes(id))) {
        issues.push({ rule: 'first-viewport-region-drift', message: `Screen ${label} firstViewport.regionIds must exactly match regions declared with viewport first.` });
      }
      const orderedIds = screen.regions.map((region) => region.id).filter((id) => declaredFirstIds.includes(id));
      if (orderedIds.join('|') !== declaredFirstIds.join('|')) {
        issues.push({ rule: 'first-viewport-order-drift', message: `Screen ${label} firstViewport.regionIds must preserve the source region order.` });
      }
      const designBudget = pack.design?.recipe?.hierarchy?.maxFirstViewportRegions;
      if (Number.isInteger(designBudget) && screen.firstViewport.maxRegions > designBudget) {
        issues.push({ rule: 'first-viewport-budget-drift', message: `Screen ${label} exceeds the design recipe's first-viewport region budget.` });
      }
    }
    if (!screen.header || screen.header.mode !== screen.headerMode || typeof screen.header.title !== 'string') {
      issues.push({ rule: 'missing-header-contract', message: `Screen ${label} lacks a coherent header contract.` });
    }
    if (['primary', 'key-flow'].includes(screen.role) && !screen.primaryAction) {
      issues.push({ rule: 'missing-critical-action', message: `Critical screen ${label} requires a primary action.` });
    }
    if (screen.firstViewport?.visiblePrimaryAction !== Boolean(screen.primaryAction)
      || screen.firstViewport?.primaryActionPlacement !== (screen.primaryAction?.placement || 'none')) {
      issues.push({ rule: 'first-viewport-action-drift', message: `Screen ${label} first viewport must preserve whether and where its primary action is visible.` });
    }
    if (screen.signatureComponent?.required === true && (!screen.signatureComponent.testId || !screen.testIds.includes(screen.signatureComponent.testId))) {
      issues.push({ rule: 'missing-signature-component-contract', message: `Screen ${label} requires a literal signature-component test ID.` });
    }
    if (screen.role === 'primary' && screen.firstViewport?.nextContentVisible !== true) issues.push({ rule: 'next-content-preview-missing', message: `Primary screen ${label} must keep a preview of the next content visible.` });
    if (screen.role === 'primary' && screen.firstViewport?.maxFeatureViewportShare > pack.design?.recipe?.hierarchy?.maxFeatureViewportShare) issues.push({ rule: 'feature-viewport-budget-drift', message: `Primary screen ${label} exceeds the visual composition feature viewport budget.` });
    if (screen.context?.entries?.length && screen.context.placementIntent === 'primary-screen-context-rail') {
      if (screen.context.entries.some((entry) => entry.source !== 'inferred-prototype-fixture' || !entry.assumption)) issues.push({ rule: 'invalid-enriched-context', message: `Screen ${label} contains context without source and assumption.` });
      if (screen.firstViewport?.focalPoint === screen.context.entries[0]?.sampleValue) issues.push({ rule: 'context-became-focal-point', message: `Screen ${label} lets inferred context replace the primary outcome.` });
    }
    if (!screen.media || typeof screen.media.required !== 'boolean' || typeof screen.media.aspectRatio !== 'string' || typeof screen.media.minCoverage !== 'number') {
      issues.push({ rule: 'missing-media-contract', message: `Screen ${label} lacks a media contract.` });
    } else if (screen.media.required && (screen.media.minCoverage < 0.8 || ['text-only', 'none'].includes(screen.media.fallback))) {
      issues.push({ rule: 'weak-required-media', message: `Screen ${label} requires at least 0.8 media coverage and a visual fallback.` });
    }
    if (screen.media?.required) {
      const firstIds = new Set(screen.firstViewport?.regionIds || []);
      if (!(screen.regions || []).some((region) => firstIds.has(region.id) && region.viewport === 'first' && region.mediaRequired === true)) {
        issues.push({ rule: 'first-viewport-required-media-missing', message: `Screen ${label} requires media but no first-viewport region owns it.` });
      }
      const sharesFirstViewport = (screen.firstViewport?.regionIds || []).length > 1
        || screen.primaryAction?.placement === 'inline';
      const expectedSizing = sharesFirstViewport ? 'responsive-clamped' : 'responsive-aspect';
      if (screen.media.sizing !== expectedSizing
        || typeof screen.media.maxViewportShare !== 'number'
        || screen.media.maxViewportShare <= 0
        || screen.media.maxViewportShare > (sharesFirstViewport ? 0.6 : 0.8)) {
        issues.push({ rule: 'invalid-first-viewport-media-budget', message: `Screen ${label} required media must use ${expectedSizing} sizing with a bounded viewport share.` });
      }
    } else if (screen.media?.sizing !== 'not-applicable' || screen.media?.maxViewportShare !== 0) {
      issues.push({ rule: 'non-media-viewport-budget', message: `Screen ${label} must not reserve a viewport media budget when media is not required.` });
    }
    if (!Array.isArray(screen.states) || !REQUIRED_STATES.every((state) => screen.states.includes(state))) {
      issues.push({ rule: 'missing-state-compositions', message: `Screen ${label} must preserve loading, empty, error, and offline states.` });
    }
    if (!Array.isArray(screen.qualityCriteria) || screen.qualityCriteria.length < 3 || !Array.isArray(screen.testIds) || !screen.testIds.length) {
      issues.push({ rule: 'missing-quality-contract', message: `Screen ${label} lacks quality criteria or test IDs.` });
    }
    if (options.projectRoot && typeof screen.file === 'string') {
      const filePath = path.resolve(options.projectRoot, screen.file);
      if (!fs.existsSync(filePath)) {
        issues.push({ rule: 'missing-screen-source', message: `Screen ${label} source is missing: ${screen.file}.` });
      } else {
        const source = fs.readFileSync(filePath, 'utf8');
        if (!/TODO:\s*screen-builder fills JSX here/i.test(source)) {
          issues.push(...validateScreenSourceContract(source, screen, {
            minimumControlSize: pack.design?.recipe?.spacing?.minimumControlSize || 44,
          }));
          if (screen.signatureComponent?.required && !source.includes(screen.signatureComponent.testId)) issues.push({ rule: 'signature-component-not-rendered', message: `Screen ${label} does not render ${screen.signatureComponent.testId}.` });
          if (/allowFontScaling\s*=\s*\{\s*false\s*\}/.test(source)) issues.push({ rule: 'dynamic-type-disabled', message: `Screen ${label} disables font scaling.` });
          if (screen.firstViewport?.nextContentVisible && !/(?:below-fold|supporting|preview|next-content)/i.test(source)) issues.push({ rule: 'next-content-source-marker-missing', message: `Screen ${label} must mark/render the contracted next-content preview.` });
        }
      }
    }
  }

  const waves = Array.isArray(pack.builderWaves) ? pack.builderWaves : [];
  validateWaveDag(waves, issues);
  const screenTargets = waves.filter((wave) => wave.kind === 'screen').flatMap((wave) => wave.targets || []);
  for (const screenId of screenIds) {
    const count = screenTargets.filter((target) => target === screenId).length;
    if (count !== 1) issues.push({ rule: 'wave-screen-coverage', message: `Screen ${screenId} must appear in exactly one builder wave; found ${count}.` });
  }
  for (const target of screenTargets) {
    if (!screenIds.has(target)) issues.push({ rule: 'unknown-wave-target', message: `Builder wave targets unknown screen ${target}.` });
  }
  const foundationWave = waves.find((wave) => wave.id === 'foundations' && wave.kind === 'foundation');
  const verticalSlice = waves.find((wave) => wave.id === 'vertical-slice' && wave.kind === 'screen');
  if (!foundationWave) issues.push({ rule: 'missing-foundation-wave', message: 'Builder waves require a foundations wave.' });
  if (!verticalSlice) issues.push({ rule: 'missing-vertical-slice-wave', message: 'Builder waves require a vertical-slice wave.' });
  else {
    const criticalIds = pack.navigation?.criticalFlow?.screenIds || [];
    if (!criticalIds.every((id) => verticalSlice.targets.includes(id))) issues.push({ rule: 'incomplete-vertical-slice', message: 'Vertical-slice wave must contain every critical-flow screen.' });
    if (!verticalSlice.gates?.includes('typecheck') || !verticalSlice.gates?.includes('static-quality-review')) issues.push({ rule: 'missing-vertical-slice-gates', message: 'Vertical-slice wave requires typecheck and static-quality-review gates.' });
    if (!verticalSlice.dependsOn?.includes('foundations')) issues.push({ rule: 'vertical-slice-order', message: 'Vertical-slice wave must depend on foundations.' });
  }
  return issues;
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-screen-composition.js --project-root <dir> [--pack .tmp/screen-build-pack.json] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const packPath = path.resolve(root, args.pack || '.tmp/screen-build-pack.json');
    const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
    const issues = validateScreenComposition(pack, { projectRoot: root });
    if (args.json) process.stdout.write(`${JSON.stringify({ validator: 'validate-screen-composition', pack: packPath, issues }, null, 2)}\n`);
    if (issues.length) {
      if (!args.json) issues.forEach((issue) => process.stderr.write(`- [${issue.rule}] ${issue.message}\n`));
      return 2;
    }
    if (!args.json) process.stdout.write(`Screen composition passed: ${packPath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: screen composition: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateScreenComposition, validateWaveDag };
