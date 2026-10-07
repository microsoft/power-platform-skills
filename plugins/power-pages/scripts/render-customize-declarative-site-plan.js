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
const { validateImageChecks, verifyPlanImages } = require('./lib/declarative-image-verification');

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
  if (options.imageChecks) validateImageChecks(plan, options.imageChecks);
  return renderTemplate({
    templatePath,
    outputPath: path.resolve(outputPath),
    dataObject: {
      SITE_NAME: String(plan.site.name),
      TEMPLATE_NAME: plan.site.templateName ? String(plan.site.templateName) : 'Existing site',
      AESTHETIC: plan.aesthetic ? String(plan.aesthetic) : 'Existing visual language',
      MOOD: plan.mood ? String(plan.mood) : 'Preserve current mood',
      NEW_SITE_DESIGN_DATA: plan.newSiteDesign || null,
      SUMMARY_DATA: { text: String(plan.summary) },
      PRESERVATION_DATA: { text: String(plan.preservation) },
      SITE_DATA: plan.site,
      CAPABILITIES_DATA: plan.capabilities,
      ASSETS_DATA: plan.assets || [],
      IMAGE_CHECKS_DATA: options.imageChecks || null,
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
      'NEW_SITE_DESIGN_DATA',
      'SUMMARY_DATA',
      'PRESERVATION_DATA',
      'SITE_DATA',
      'CAPABILITIES_DATA',
      'ASSETS_DATA',
      'IMAGE_CHECKS_DATA',
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

async function renderReviewedPlan(plan, outputPath, options = {}) {
  const output = path.resolve(outputPath);
  const imageChecksPath = `${output}.image-checks.json`;
  if (fs.existsSync(output) || fs.existsSync(imageChecksPath)) {
    throw new Error('Output file already exists. Choose a fresh review directory.');
  }
  const imageChecks = await verifyPlanImages(plan, options);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(imageChecksPath, `${JSON.stringify(imageChecks, null, 2)}\n`, { flag: 'wx' });
  renderCustomizationPlan(plan, output, { imageChecks, emitStatus: false });
  return { status: 'ok', output, imageChecks: imageChecksPath, verifiedImages: imageChecks.images.length };
}

async function main() {
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
    console.log(JSON.stringify(await renderReviewedPlan(plan, args.output)));
  } catch (error) {
    console.error(`Invalid plan: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { renderCustomizationPlan, renderReviewedPlan };
