#!/usr/bin/env node
/**
 * Render a browser-viewable declarative-site customization plan from its persisted JSON source.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs, renderTemplate } = require('./lib/render-template');

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

const required = [
  'schemaVersion',
  'site',
  'summary',
  'preservation',
  'aesthetic',
  'mood',
  'capabilities',
  'operations',
  'warnings',
  'verification',
  'deployment',
];
const allowedSkills = new Set([
  'author-web-file',
  'author-content-snippet',
  'author-web-template',
  'author-page-template',
  'author-webpage',
  'author-webpage-content',
  'style-site',
]);
const missing = required.filter((key) => !(key in plan));
if (missing.length > 0) {
  console.error(`Missing required plan keys: ${missing.join(', ')}`);
  process.exit(1);
}

if (!plan.site || typeof plan.site !== 'object' || Array.isArray(plan.site)) {
  console.error('Invalid plan: site must be an object');
  process.exit(1);
}

for (const key of ['name', 'siteRoot', 'languages']) {
  if (!(key in plan.site)) {
    console.error(`Invalid plan: site.${key} is required`);
    process.exit(1);
  }
}

if (plan.schemaVersion !== 1) {
  console.error(`Invalid plan: unsupported schemaVersion ${plan.schemaVersion}`);
  process.exit(1);
}
if (!Array.isArray(plan.site.languages) || plan.site.languages.some((value) => typeof value !== 'string')) {
  console.error('Invalid plan: site.languages must be an array of strings');
  process.exit(1);
}

for (const key of ['capabilities', 'operations', 'warnings', 'verification', 'deployment']) {
  if (!Array.isArray(plan[key])) {
    console.error(`Invalid plan: ${key} must be an array`);
    process.exit(1);
  }
}

const operationIds = new Set();
for (const operation of plan.operations) {
  if (!operation || typeof operation !== 'object') {
    console.error('Invalid plan: every operation must be an object');
    process.exit(1);
  }
  if (typeof operation.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(operation.id)) {
    console.error('Invalid plan: every operation id must be kebab-case');
    process.exit(1);
  }
  if (operationIds.has(operation.id)) {
    console.error(`Invalid plan: duplicate operation id ${operation.id}`);
    process.exit(1);
  }
  if (!allowedSkills.has(operation.skill)) {
    console.error(`Invalid plan: unsupported operation skill ${operation.skill}`);
    process.exit(1);
  }
  if (typeof operation.action !== 'string' || operation.action.trim() === '') {
    console.error(`Invalid plan: operation ${operation.id} requires an action`);
    process.exit(1);
  }
  for (const key of ['target', 'inputs', 'resolvedDependencies']) {
    if (!operation[key] || typeof operation[key] !== 'object' || Array.isArray(operation[key])) {
      console.error(`Invalid plan: operation ${operation.id}.${key} must be an object`);
      process.exit(1);
    }
  }
  for (const key of ['locales', 'dependsOn', 'preserve', 'expectedOutputs']) {
    if (!Array.isArray(operation[key])) {
      console.error(`Invalid plan: operation ${operation.id}.${key} must be an array`);
      process.exit(1);
    }
  }
  for (const dependency of operation.dependsOn) {
    if (!operationIds.has(dependency)) {
      console.error(
        `Invalid plan: operation ${operation.id} depends on ${dependency}, which must appear earlier`
      );
      process.exit(1);
    }
  }
  operationIds.add(operation.id);
}

const templatePath = path.join(
  __dirname,
  '..',
  'skills',
  'customize-declarative-site',
  'assets',
  'customization-plan.html'
);

renderTemplate({
  templatePath,
  outputPath: path.resolve(args.output),
  dataObject: {
    SITE_NAME: String(plan.site.name),
    TEMPLATE_NAME: plan.site.templateName ? String(plan.site.templateName) : 'Existing site',
    AESTHETIC: plan.aesthetic ? String(plan.aesthetic) : 'Existing visual language',
    MOOD: plan.mood ? String(plan.mood) : 'Preserve current mood',
    SUMMARY_DATA: { text: String(plan.summary) },
    PRESERVATION_DATA: { text: String(plan.preservation) },
    SITE_DATA: plan.site,
    CAPABILITIES_DATA: plan.capabilities,
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
    'OPERATIONS_DATA',
    'WARNINGS_DATA',
    'VERIFICATION_DATA',
    'DEPLOYMENT_DATA',
  ],
});
