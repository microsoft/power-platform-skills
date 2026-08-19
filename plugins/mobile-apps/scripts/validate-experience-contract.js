#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PRODUCT_ARCHETYPES = new Set([
  'asset-maintenance-cmms',
  'field-inspection',
  'field-service-dispatch',
  'facilities-operations',
  'inventory-scan-first',
  'crm-relationship-workspace',
  'retail-catalog',
  'healthcare-wellness',
  'consumer-fitness',
  'learning-coaching',
  'finance-operations',
  'scheduling-booking',
  'admin-operations',
  'custom',
]);

const VISUAL_PERSONALITIES = new Set([
  'utility',
  'polished-operational',
  'premium-brand-forward',
  'editorial',
  'immersive',
  'playful-consumer',
  'reference-driven',
]);

const HOME_COMPOSITIONS = new Set([
  'asset-command',
  'media-command',
  'object-command',
  'relationship-command',
  'data-command',
  'scan-command',
  'queue-first',
  'timeline-first',
  'narrative-home',
  'personalized-feed',
  'operational-dashboard',
]);

const ENUMS = {
  'classification confidence': new Set(['high', 'medium', 'low']),
  'visual ambition': new Set(['template', 'tailored', 'premium', 'bespoke']),
  'content emphasis': new Set(['image-led', 'object-led', 'data-led', 'relationship-led', 'task-led', 'timeline-led']),
  'navigation mood': new Set(['functional', 'atmospheric', 'cinematic', 'reference-driven']),
  density: new Set(['sparse', 'comfortable', 'compact', 'dense']),
  'reference fidelity': new Set(['none', 'directional', 'high', 'strict-structural']),
  'media strategy': new Set(['record-media', 'local-ui-media', 'generated-placeholder', 'mixed', 'none']),
};

const FIRST_VIEWPORT_ENUMS = {
  media: new Set(['required', 'optional', 'forbidden']),
  'primary action': new Set(['integrated', 'in-flow', 'bottom-dock', 'native-navigation']),
  'next section visible': new Set(['yes', 'no']),
  'duplicate action with tab': new Set(['allowed', 'forbidden']),
};

const REQUIRED_FIELDS = [
  'contract version',
  'industry context',
  'product archetype',
  'classification confidence',
  'classification evidence',
  'workflow capabilities',
  'operating context',
  'visual personality',
  'visual ambition',
  'content emphasis',
  'home composition',
  'navigation mood',
  'navigation silhouette',
  'density',
  'reference fidelity',
  'media strategy',
  'media source',
  'media fallback',
];

const REQUIRED_VIEWPORT_FIELDS = [
  'signature component',
  'viewport share',
  'minimum height',
  'media',
  'headline minimum',
  'supporting metrics maximum',
  'primary action',
  'next section visible',
  'duplicate action with tab',
];

const REQUIRED_REFERENCE_FIELDS = [
  'source',
  'fidelity',
  'required hierarchy',
  'required media ratio',
  'required typography scale',
  'required navigation silhouette',
  'required repeated motifs',
  'forbidden drift',
  'explicit non-goals',
];

function parseArgs(argv) {
  const args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') args.projectRoot = argv[++index];
    else if (arg === '--plan') args.plan = argv[++index];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function stripMarkup(value) {
  return String(value || '')
    .replace(/<!--.*?-->/g, '')
    .replace(/^\s*\*\*|\*\*\s*$/g, '')
    .replace(/^\s*`|`\s*$/g, '')
    .trim();
}

function normalizeKey(value) {
  return stripMarkup(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function normalizedValue(value) {
  return stripMarkup(value).toLowerCase();
}

function isPlaceholder(value) {
  const text = stripMarkup(value);
  return !text || /^<.*>$/.test(text) || /\{\{.*\}\}/.test(text) || /^tbd$/i.test(text);
}

function getSection(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function getSubsection(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `### ${title}`);
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,3}\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function parseBulletFields(markdown) {
  const fields = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    let match = /^\s*-\s+\*\*([^*]+):\*\*\s*(.+?)\s*$/.exec(line);
    if (!match) match = /^\s*-\s+([^:]+):\s*(.+?)\s*$/.exec(line);
    if (match) fields.set(normalizeKey(match[1]), stripMarkup(match[2]));
  }
  return fields;
}

function parseTableFields(markdown) {
  const fields = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
    if (!match) continue;
    const key = normalizeKey(match[1]);
    if (key === 'field' || /^-+$/.test(key)) continue;
    fields.set(key, stripMarkup(match[2]));
  }
  return fields;
}

function parseYamlFields(markdown) {
  const fields = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\s*([a-z][a-z0-9_]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (match) fields.set(normalizeKey(match[1]), stripMarkup(match[2].replace(/\s+#.*$/, '')));
  }
  return fields;
}

function numberFrom(value) {
  const match = /-?\d+(?:\.\d+)?/.exec(String(value || ''));
  return match ? Number(match[0]) : Number.NaN;
}

function addIssue(issues, rule, message, field, value) {
  issues.push({ rule, message, ...(field ? { field } : {}), ...(value !== undefined ? { value } : {}) });
}

function requireFields(fields, required, issues, scope) {
  for (const key of required) {
    const value = fields.get(key);
    if (isPlaceholder(value)) addIssue(issues, 'missing-field', `${scope} is missing a concrete value for ${key}.`, key, value);
  }
}

function validateDesignIntake(projectRoot, source, issues) {
  const intakePath = source && source.includes('design-intake.md')
    ? path.resolve(projectRoot, source.match(/(?:^|\s)([^,]*design-intake\.md)/)?.[1]?.trim() || 'design-intake.md')
    : path.join(projectRoot, 'design-intake.md');
  if (!fs.existsSync(intakePath) || !fs.statSync(intakePath).isFile()) {
    addIssue(issues, 'missing-design-intake', `Reference fidelity requires ${intakePath}.`);
    return;
  }
  const intake = fs.readFileSync(intakePath, 'utf8');
  const headings = [
    'Hierarchy',
    'Measured Geometry',
    'Typography',
    'Navigation Silhouette',
    'Required Motifs',
    'Forbidden Drift',
    'Originality and Asset Policy',
  ];
  for (const heading of headings) {
    if (!new RegExp(`^## ${heading}\\s*$`, 'm').test(intake)) {
      addIssue(issues, 'invalid-design-intake', `design-intake.md is missing ## ${heading}.`);
    }
  }
}

function validateDesignDirection(markdown, fields, viewport, issues) {
  const section = getSection(markdown, 'Design Direction');
  if (!section) {
    addIssue(issues, 'missing-design-direction', 'Plan is missing ## Design Direction.');
    return;
  }
  const values = parseYamlFields(section);
  const required = [
    'visual personality', 'visual ambition', 'materialization profile',
    'product archetype', 'home composition', 'content emphasis',
    'reference fidelity', 'first viewport signature', 'first viewport share',
    'first viewport min height', 'first viewport media',
    'first viewport headline min', 'first viewport metrics max',
    'first viewport action', 'first viewport next section visible',
    'duplicate action with tab', 'media strategy', 'media source',
    'media fallback', 'navigation silhouette',
  ];
  requireFields(values, required, issues, 'Design Direction');

  const comparisons = [
    ['visual personality', 'visual personality'],
    ['visual ambition', 'visual ambition'],
    ['product archetype', 'product archetype'],
    ['home composition', 'home composition'],
    ['content emphasis', 'content emphasis'],
    ['reference fidelity', 'reference fidelity'],
    ['media strategy', 'media strategy'],
    ['media source', 'media source'],
    ['media fallback', 'media fallback'],
    ['navigation silhouette', 'navigation silhouette'],
    ['first viewport signature', 'signature component'],
    ['first viewport share', 'viewport share'],
    ['first viewport min height', 'minimum height'],
    ['first viewport media', 'media'],
    ['first viewport headline min', 'headline minimum'],
    ['first viewport metrics max', 'supporting metrics maximum'],
    ['first viewport action', 'primary action'],
    ['duplicate action with tab', 'duplicate action with tab'],
  ];
  for (const [directionKey, contractKey] of comparisons) {
    if (!values.has(directionKey)) continue;
    const source = viewport.has(contractKey) ? viewport : fields;
    const expected = source.get(contractKey);
    const actual = values.get(directionKey);
    if (!isPlaceholder(expected) && normalizedValue(actual) !== normalizedValue(expected)) {
      addIssue(issues, 'direction-contract-drift', `${directionKey} does not match Product Experience.`, directionKey, actual);
    }
  }
  const nextSection = normalizedValue(values.get('first viewport next section visible'));
  const expectedNext = normalizedValue(viewport.get('next section visible'));
  if (nextSection && expectedNext && nextSection !== expectedNext && !(nextSection === 'true' && expectedNext === 'yes') && !(nextSection === 'false' && expectedNext === 'no')) {
    addIssue(issues, 'direction-contract-drift', 'first_viewport_next_section_visible does not match Product Experience.', 'first viewport next section visible', values.get('first viewport next section visible'));
  }
}

function validateScreens(markdown, fields, issues) {
  const screens = getSection(markdown, 'Screens');
  if (!screens || !/### Per-Screen Specs/m.test(screens)) return;
  const lines = screens.split(/\r?\n/);
  const homeStart = lines.findIndex((line) => /^#{3,4}\s+Home\s*\(/i.test(line));
  if (homeStart < 0) {
    addIssue(issues, 'missing-home-spec', 'Screens section has no Home per-screen spec.');
    return;
  }
  const level = /^#+/.exec(lines[homeStart])[0].length;
  let homeEnd = lines.length;
  for (let index = homeStart + 1; index < lines.length; index += 1) {
    const heading = /^(#+)\s+/.exec(lines[index]);
    if (heading && heading[1].length <= level) {
      homeEnd = index;
      break;
    }
  }
  const home = lines.slice(homeStart + 1, homeEnd).join('\n');
  if (!/\*\*Home composition:\*\*/i.test(home)) addIssue(issues, 'missing-home-composition', 'Home spec is missing **Home composition:**.');
  if (!/\*\*First viewport materialization:\*\*/i.test(home)) addIssue(issues, 'missing-first-viewport-materialization', 'Home spec is missing **First viewport materialization:**.');
  if (normalizedValue(fields.get('reference fidelity')) !== 'none' && !/\*\*Reference materialization:\*\*/i.test(home)) {
    addIssue(issues, 'missing-reference-materialization', 'Home spec is missing **Reference materialization:** for a referenced design.');
  }
  if (/### Navigation Pattern[\s\S]*?Tabs/i.test(screens) && !/\*\*Tab-root silhouettes\*\*/i.test(screens)) {
    addIssue(issues, 'missing-tab-silhouettes', 'Tabbed screen plan is missing **Tab-root silhouettes** in Shared Conventions.');
  }
}

function validateExperienceContract(markdown, options = {}) {
  const issues = [];
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const section = getSection(markdown, 'Product Experience');
  if (!section) {
    addIssue(issues, 'missing-product-experience', 'Plan is missing ## Product Experience.');
    return issues;
  }

  const beforeViewport = section.split(/^### First Viewport Contract\s*$/m)[0];
  const fields = parseBulletFields(beforeViewport);
  requireFields(fields, REQUIRED_FIELDS, issues, 'Product Experience');

  if (fields.get('contract version') !== '1') addIssue(issues, 'unsupported-contract-version', 'Contract version must be 1.', 'contract version', fields.get('contract version'));
  if (!PRODUCT_ARCHETYPES.has(normalizedValue(fields.get('product archetype')))) addIssue(issues, 'invalid-enum', 'Unknown product archetype.', 'product archetype', fields.get('product archetype'));
  if (!VISUAL_PERSONALITIES.has(normalizedValue(fields.get('visual personality')))) addIssue(issues, 'invalid-enum', 'Unknown visual personality.', 'visual personality', fields.get('visual personality'));
  if (!HOME_COMPOSITIONS.has(normalizedValue(fields.get('home composition')))) addIssue(issues, 'invalid-enum', 'Unknown Home composition.', 'home composition', fields.get('home composition'));
  for (const [key, allowed] of Object.entries(ENUMS)) {
    const value = normalizedValue(fields.get(key));
    if (value && !allowed.has(value)) addIssue(issues, 'invalid-enum', `${key} has an unsupported value.`, key, fields.get(key));
  }

  const viewportSection = getSubsection(section, 'First Viewport Contract');
  const viewport = parseTableFields(viewportSection);
  requireFields(viewport, REQUIRED_VIEWPORT_FIELDS, issues, 'First Viewport Contract');
  for (const [key, allowed] of Object.entries(FIRST_VIEWPORT_ENUMS)) {
    const value = normalizedValue(viewport.get(key));
    if (value && !allowed.has(value)) addIssue(issues, 'invalid-enum', `${key} has an unsupported value.`, key, viewport.get(key));
  }

  const share = numberFrom(viewport.get('viewport share'));
  if (!Number.isFinite(share) || share < 0.2 || share > 0.65) addIssue(issues, 'invalid-range', 'Viewport share must be between 0.20 and 0.65.', 'viewport share', viewport.get('viewport share'));
  const minHeight = numberFrom(viewport.get('minimum height'));
  if (!Number.isInteger(minHeight) || minHeight < 120) addIssue(issues, 'invalid-range', 'Minimum height must be an integer of at least 120dp.', 'minimum height', viewport.get('minimum height'));
  const headline = numberFrom(viewport.get('headline minimum'));
  if (!Number.isInteger(headline) || headline < 20 || headline > 72) addIssue(issues, 'invalid-range', 'Headline minimum must be an integer from 20sp to 72sp.', 'headline minimum', viewport.get('headline minimum'));
  const metrics = numberFrom(viewport.get('supporting metrics maximum'));
  if (!Number.isInteger(metrics) || metrics < 0 || metrics > 4) addIssue(issues, 'invalid-range', 'Supporting metrics maximum must be 0-4.', 'supporting metrics maximum', viewport.get('supporting metrics maximum'));

  const media = normalizedValue(viewport.get('media'));
  const mediaStrategy = normalizedValue(fields.get('media strategy'));
  const mediaSource = normalizedValue(fields.get('media source'));
  if (media === 'required' && (mediaStrategy === 'none' || mediaSource === 'none')) addIssue(issues, 'missing-required-media', 'Required first-viewport media needs a non-none strategy and source.');
  if (mediaStrategy !== 'none' && mediaSource === 'none') addIssue(issues, 'missing-media-source', 'Non-none media strategy requires a concrete media source.');
  if (normalizedValue(fields.get('home composition')) === 'media-command' && media !== 'required') addIssue(issues, 'media-command-contract', 'media-command requires first-viewport media=required.');

  const fidelity = normalizedValue(fields.get('reference fidelity'));
  const referenceSection = getSubsection(section, 'Reference Contract');
  if (fidelity !== 'none') {
    const reference = parseBulletFields(referenceSection);
    requireFields(reference, REQUIRED_REFERENCE_FIELDS, issues, 'Reference Contract');
    if (normalizedValue(reference.get('fidelity')) !== fidelity) addIssue(issues, 'reference-fidelity-drift', 'Reference Contract fidelity must match Product Experience.', 'fidelity', reference.get('fidelity'));
    if (fidelity === 'high' || fidelity === 'strict-structural') validateDesignIntake(projectRoot, reference.get('source'), issues);
  }
  if (normalizedValue(fields.get('visual personality')) === 'reference-driven' && fidelity === 'none') addIssue(issues, 'reference-personality-without-source', 'reference-driven personality requires non-none reference fidelity.');
  if (normalizedValue(fields.get('navigation mood')) === 'reference-driven' && fidelity === 'none') addIssue(issues, 'reference-navigation-without-source', 'reference-driven navigation requires non-none reference fidelity.');

  validateDesignDirection(markdown, fields, viewport, issues);
  validateScreens(markdown, fields, issues);
  return issues;
}

function usage() {
  return 'Usage: node validate-experience-contract.js --project-root <path> [--plan <path>] [--json]';
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const projectRoot = path.resolve(args.projectRoot || process.cwd());
  const planPath = path.resolve(projectRoot, args.plan || 'native-app-plan.md');
  if (!fs.existsSync(planPath) || !fs.statSync(planPath).isFile()) {
    process.stderr.write(`BLOCKED: plan not found: ${planPath}\n`);
    return 2;
  }
  const issues = validateExperienceContract(fs.readFileSync(planPath, 'utf8'), { projectRoot });
  if (args.json) process.stdout.write(`${JSON.stringify({ validator: 'validate-experience-contract', plan: planPath, issues }, null, 2)}\n`);
  if (issues.length > 0) {
    if (!args.json) {
      process.stderr.write(`BLOCKED: Product Experience contract has ${issues.length} issue(s):\n`);
      for (const issue of issues) process.stderr.write(`- [${issue.rule}] ${issue.message}${issue.field ? ` (${issue.field}: ${issue.value || '<missing>'})` : ''}\n`);
    }
    return 2;
  }
  if (!args.json) process.stdout.write(`Product Experience contract passed: ${planPath}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  HOME_COMPOSITIONS,
  PRODUCT_ARCHETYPES,
  VISUAL_PERSONALITIES,
  getSection,
  getSubsection,
  parseBulletFields,
  parseTableFields,
  parseYamlFields,
  validateExperienceContract,
};
