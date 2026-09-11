#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  validatePlan, compileStyles, replaceBlock, VALUES, KINDS,
} = require('../../../scripts/lib/style-site-plan');
const {
  assertOutsideSite, parseArgs, readText, resolveSiteRoot, safePath,
} = require('../../../scripts/lib/classic-site-style-context');
const {
  renderTemplate, serializeJson, escapeHtml, escapeHtmlAttribute,
} = require('../../../scripts/lib/render-template');

const TEMPLATE = path.join(__dirname, '..', 'assets', 'style-preview.html');
const SAMPLES = path.join(__dirname, '..', 'assets', 'component-samples.json');

function rebuildPreview(plan, request) {
  const layers = plan.preview.layers.map((layer) => ({ ...layer }));
  for (const rule of compileStyles(request)) {
    const placement = plan.placements.find((entry) => entry.styleId === rule.id && entry.owner === 'custom');
    const layer = layers.find((entry) => entry.path === placement?.path);
    if (!layer) throw new Error(`Missing preview layer for ${rule.id}. Regenerate the proposal.`);
    // Replace in the original destination, never in a final catch-all stylesheet.
    // In particular, portalbasictheme.css may legitimately follow a custom file.
    layer.after = replaceBlock(layer.after, rule.id, rule.css);
  }
  return {
    layers,
    studioCss: compileStyles(request, 'studio').map((entry) => entry.css).join('\n'),
  };
}

function validatePreview(plan) {
  validatePlan(plan);
  if (typeof plan.siteRoot !== 'string' || !path.isAbsolute(plan.siteRoot) ||
      !Array.isArray(plan.placements) || !Array.isArray(plan.warnings) ||
      !Array.isArray(plan.preview?.components) || !Array.isArray(plan.preview?.layers) ||
      typeof plan.preview.studioCss !== 'string') {
    throw new Error('Invalid preview context; regenerate the proposal.');
  }
  const components = plan.preview.components;
  if (components.length !== plan.request.components.length) throw new Error('Preview component count does not match the request.');
  for (const [index, component] of components.entries()) {
    const { before, after, simulation, ...identity } = component;
    if (JSON.stringify(identity) !== JSON.stringify(plan.request.components[index]) ||
        ![before, after].every((value) => value === null || typeof value === 'string') ||
        (before === null) !== (after === null) || typeof simulation !== 'boolean') {
      throw new Error('Preview component source does not match the request.');
    }
    const write = plan.writes.find((entry) => entry.kind === 'class' &&
      entry.path === component.sourcePath?.split('\\').join('/'));
    if ((write && (write.before !== before || write.after !== after)) || (!write && before !== after)) {
      throw new Error('Preview markup does not match the proposed class edits.');
    }
  }
  const paths = new Set();
  for (const layer of plan.preview.layers) {
    safePath(plan.siteRoot, layer.path);
    if (paths.has(layer.path) || typeof layer.before !== 'string' || typeof layer.after !== 'string') {
      throw new Error('Invalid or duplicate preview CSS layer.');
    }
    paths.add(layer.path);
    const write = plan.writes.find((entry) => entry.kind === 'css' && entry.path === layer.path);
    if (layer.before !== (write ? write.before ?? '' : layer.after) || (write && layer.after !== write.after)) {
      throw new Error('Preview CSS does not match the proposed local write.');
    }
  }
  for (const write of plan.writes.filter((entry) => entry.kind === 'css')) {
    if (!paths.has(write.path)) throw new Error('A proposed CSS write is missing from the preview.');
  }
  if (plan.placements.length !== plan.request.styles.length) throw new Error('Invalid preview placement count.');
  for (const style of plan.request.styles) {
    const placements = plan.placements.filter((entry) => entry.styleId === style.id);
    if (placements.length !== 1 || placements[0].owner !== style.owner || placements[0].scope !== style.scope) {
      throw new Error('Preview styling ownership does not match the request.');
    }
  }
  const rebuilt = rebuildPreview(plan, plan.request);
  if (rebuilt.studioCss !== plan.preview.studioCss ||
      rebuilt.layers.some((layer, index) => layer.after !== plan.preview.layers[index].after)) {
    throw new Error('Preview CSS is inconsistent with the shared compiler.');
  }
  return plan;
}

function validateDraftValues(request) {
  // Only declaration values are editable in this UI. Its request skeleton has
  // already passed validatePlan; an exported draft must be revalidated by prepare.
  for (const style of request.styles) {
    for (const [property, value] of Object.entries(style.declarations)) {
      if (!Object.hasOwn(VALUES, property) || typeof value !== 'string' || !VALUES[property].test(value)) {
        throw new Error(`Unsupported ${property} value. Use the permitted values shown by the control.`);
      }
    }
  }
  return request;
}

function browserRuntime() {
  const values = Object.fromEntries(Object.entries(VALUES)
    .map(([property, rule]) => [property, { source: rule.source, flags: rule.flags }]));
  // These RAW functions are code-owned, never request strings. Embedding the
  // actual shared compiler and block writer keeps browser revisions byte-for-byte
  // consistent with apply, including sorted declarations and CRLF preservation.
  return [
    `const VALUES = Object.fromEntries(Object.entries(${serializeJson(values)}).map(([key, rule]) => [key, new RegExp(rule.source, rule.flags)]));`,
    escapeHtml.toString(),
    escapeHtmlAttribute.toString(),
    validateDraftValues.toString(),
    `const compileStyles = (() => { const validateRequest = validateDraftValues; return ${compileStyles.toString()}; })();`,
    replaceBlock.toString(),
    rebuildPreview.toString(),
  ].join('\n');
}

function renderStylePreview(plan, output, confirmedSiteRoot) {
  validatePreview(plan);
  const root = fs.existsSync(plan.siteRoot) ? fs.realpathSync(plan.siteRoot) : path.resolve(plan.siteRoot);
  if (confirmedSiteRoot && resolveSiteRoot(confirmedSiteRoot) !== root) {
    throw new Error('--siteRoot does not match this proposal. Regenerate the proposal for the selected site.');
  }
  const outputPath = assertOutsideSite(root, output);
  // lstat also catches dangling symlinks, which existsSync does not consider an
  // existing file. Never let rendering follow such a link when creating output.
  try {
    fs.lstatSync(outputPath);
    throw new Error(`Output file already exists: ${outputPath}. Choose a new preview filename.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // The catalog's hook is expanded in the browser, not by renderTemplate. Use a
  // neutral intermediate class so its unresolved-token check stays meaningful.
  const samples = JSON.parse(fs.readFileSync(SAMPLES, 'utf8')
    .replaceAll('__COMPONENT_CLASS__', 'pp-style-preview-component'));
  if (samples.schemaVersion !== 1 ||
      ![3, 5].every((major) => KINDS.every((kind) => typeof samples.versions?.[major]?.[kind]?.html === 'string'))) {
    throw new Error('The bundled component sample catalog is incomplete.');
  }
  renderTemplate({
    templatePath: TEMPLATE,
    outputPath,
    dataObject: { TITLE: plan.title, PLAN: plan, SAMPLES: samples, STYLE_RUNTIME: browserRuntime() },
    requiredKeys: ['TITLE', 'PLAN', 'SAMPLES', 'STYLE_RUNTIME'],
    copyIcon: false,
  });
  return { status: 'ok', output: outputPath };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, ['plan', 'out', 'siteRoot']);
  if (!args.plan || !args.out) throw new Error('Usage: render-style-preview.js --plan <proposal.json> --out <preview.html> [--siteRoot <classic-export>]');
  return renderStylePreview(JSON.parse(readText(path.resolve(args.plan))), args.out, args.siteRoot);
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`Style preview: ${error.message}`); process.exitCode = 1; }
}

module.exports = { main, renderStylePreview, validatePreview, rebuildPreview, browserRuntime };
