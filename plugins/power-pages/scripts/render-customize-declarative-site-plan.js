#!/usr/bin/env node
/**
 * Render a browser-viewable declarative-site customization plan from its persisted JSON source.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs, renderTemplate } = require('./lib/render-template');
const {
  validateCustomizationPlan,
} = require('./lib/customize-declarative-site-plan');

const templatePath = path.join(
  __dirname,
  '..',
  'skills',
  'customize-declarative-site',
  'assets',
  'customization-plan.html'
);

function renderCustomizationPlan(plan, outputPath, options = {}) {
  validateCustomizationPlan(plan);
  return renderTemplate({
    templatePath,
    outputPath: path.resolve(outputPath),
    dataObject: {
      SITE_NAME: String(plan.site.name),
      TEMPLATE_NAME: plan.site.templateName ? String(plan.site.templateName) : 'Existing site',
      AESTHETIC: plan.aesthetic ? String(plan.aesthetic) : 'Existing visual language',
      MOOD: plan.mood ? String(plan.mood) : 'Preserve current mood',
      SUMMARY_DATA: { text: String(plan.summary) },
      PRESERVATION_DATA: { text: String(plan.preservation) },
      SITE_DATA: plan.site,
      CAPABILITIES_DATA: plan.capabilities,
      ASSETS_DATA: plan.assets || [],
      OPERATIONS_DATA: plan.operations,
      WARNINGS_DATA: plan.warnings,
      VERIFICATION_DATA: plan.verification,
      DEPLOYMENT_DATA: plan.deployment,
    },
    requiredKeys: [
      'SITE_NAME',
      'TEMPLATE_NAME',
      'AESTHETIC',
      'MOOD',
      'SUMMARY_DATA',
      'PRESERVATION_DATA',
      'SITE_DATA',
      'CAPABILITIES_DATA',
      'ASSETS_DATA',
      'OPERATIONS_DATA',
      'WARNINGS_DATA',
      'VERIFICATION_DATA',
      'DEPLOYMENT_DATA',
    ],
    overwrite: options.overwrite === true,
    emitStatus: options.emitStatus !== false,
    copyIcon: options.copyIcon !== false,
  });
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.output || !args.data) {
    console.error(
      'Usage: node render-customize-declarative-site-plan.js --output <path> --data <json-file>'
    );
    process.exit(1);
  }

  const dataPath = path.resolve(args.data);
  if (!fs.existsSync(dataPath)) {
    console.error(`Data file not found: ${dataPath}`);
    process.exit(1);
  }

  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch {
    console.error('Error: --data file is not valid JSON');
    process.exit(1);
  }

  try {
    renderCustomizationPlan(plan, args.output);
  } catch (error) {
    console.error(`Invalid plan: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { renderCustomizationPlan };
