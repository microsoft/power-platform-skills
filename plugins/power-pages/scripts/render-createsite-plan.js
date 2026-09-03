#!/usr/bin/env node
/**
 * render-createsite-plan.js — Renders the create-site implementation plan HTML.
 *
 * Usage (inline JSON):
 *   node render-createsite-plan.js --output <path> --data-inline '<json>'
 *
 * Usage (file-based):
 *   node render-createsite-plan.js --output <path> --data <json-file>
 *
 * Required keys in the data:
 *   SITE_NAME, PLAN_TITLE, FRAMEWORK, SITE_LANGUAGE, SITE_LOCALE, SITE_DIRECTION,
 *   AESTHETIC, MOOD, SUMMARY, PLAN_LABELS,
 *   TYPOGRAPHY_DATA, PALETTE_DATA, MOTION_DATA, BACKGROUNDS_DATA,
 *   PAGES_DATA, COMPONENTS_DATA, ROUTES_DATA, BIDIRECTIONAL_REVIEW_DATA,
 *   REVIEW_DATA, DEPLOYMENT_DATA
 */

const path = require('path');
const fs = require('fs');
const { renderTemplate, parseArgs } = require('./lib/render-template');
const { resolveLocale } = require('./lib/localization-config');

const args = parseArgs(process.argv);

if (!args.output || (!args['data-inline'] && !args.data)) {
  console.error(
    'Usage: node render-createsite-plan.js --output <path> --data-inline \'<json>\'\n' +
    '       node render-createsite-plan.js --output <path> --data <json-file>'
  );
  process.exit(1);
}

const templatePath = path.join(
  __dirname,
  '..',
  'skills',
  'create-site',
  'assets',
  'create-site-plan.html'
);

const requiredKeys = [
  'SITE_NAME',
  'PLAN_TITLE',
  'FRAMEWORK',
  'SITE_LANGUAGE',
  'SITE_LOCALE',
  'SITE_DIRECTION',
  'AESTHETIC',
  'MOOD',
  'SUMMARY',
  'PLAN_LABELS',
  'TYPOGRAPHY_DATA',
  'PALETTE_DATA',
  'MOTION_DATA',
  'BACKGROUNDS_DATA',
  'PAGES_DATA',
  'COMPONENTS_DATA',
  'ROUTES_DATA',
  'BIDIRECTIONAL_REVIEW_DATA',
  'REVIEW_DATA',
  'DEPLOYMENT_DATA',
];

const requiredLabelPaths = [
  'navigation.group',
  'navigation.overview',
  'navigation.design',
  'navigation.pages',
  'navigation.deployment',
  'overview.title',
  'overview.description',
  'overview.stats.pages',
  'overview.stats.components',
  'overview.stats.routes',
  'overview.nextSteps.title',
  'overview.nextSteps.design.title',
  'overview.nextSteps.design.description',
  'overview.nextSteps.components.title',
  'overview.nextSteps.components.descriptionOne',
  'overview.nextSteps.components.descriptionOther',
  'overview.nextSteps.pages.title',
  'overview.nextSteps.pages.descriptionOne',
  'overview.nextSteps.pages.descriptionOther',
  'overview.nextSteps.verify.title',
  'overview.nextSteps.verify.description',
  'design.title',
  'design.description',
  'design.typography',
  'design.palette',
  'design.motion',
  'design.backgrounds',
  'design.primaryRole',
  'design.secondaryRole',
  'pages.title',
  'pages.description',
  'pages.pages',
  'pages.components',
  'pages.routing',
  'pages.path',
  'pages.page',
  'pages.content',
  'pages.componentsUsed',
  'pages.usedBy',
  'pages.noComponents',
  'bidirectional.title',
  'bidirectional.description',
  'bidirectional.classification',
  'bidirectional.reason',
  'bidirectional.states',
  'bidirectional.viewports',
  'bidirectional.checks',
  'bidirectional.classifications.directionNeutral',
  'bidirectional.classifications.directionAware',
  'bidirectional.classifications.directionFixed',
  'bidirectional.classifications.unknownThirdParty',
  'bidirectional.viewport.desktop',
  'bidirectional.viewport.narrow',
  'deployment.title',
  'deployment.description',
  'deployment.verify',
  'deployment.agentChecks',
  'deployment.agentChecksDescription',
  'deployment.makerReview',
  'deployment.makerReviewDescription',
  'deployment.options',
  'deployment.recommended',
  'common.noneSpecified',
  'footer.aiWarning',
];

const BIDIRECTIONAL_CLASSIFICATIONS = new Set([
  'direction-neutral',
  'direction-aware',
  'direction-fixed',
  'unknown-third-party',
]);
const BIDIRECTIONAL_VIEWPORTS = new Set(['desktop', 'narrow']);

function getNestedValue(value, dottedPath) {
  return dottedPath.split('.').reduce(
    (current, key) => current && current[key],
    value
  );
}

function validatePlanData(dataObject) {
  const locale = resolveLocale(dataObject.SITE_LOCALE);
  if (!locale.valid || !locale.locale) {
    return [`SITE_LOCALE must be a valid BCP-47 locale: ${dataObject.SITE_LOCALE}`];
  }
  if (locale.locale !== dataObject.SITE_LOCALE) {
    return [
      `SITE_LOCALE must be canonical BCP-47. Use "${locale.locale}" instead of ` +
      `"${dataObject.SITE_LOCALE}".`,
    ];
  }
  if (!['ltr', 'rtl'].includes(dataObject.SITE_DIRECTION)) {
    return ['SITE_DIRECTION must be either "ltr" or "rtl".'];
  }
  if (locale.direction !== dataObject.SITE_DIRECTION) {
    return [
      `SITE_DIRECTION "${dataObject.SITE_DIRECTION}" does not match ` +
      `${locale.locale}, which resolves to "${locale.direction}".`,
    ];
  }

  if (!dataObject.REVIEW_DATA || Array.isArray(dataObject.REVIEW_DATA) ||
      typeof dataObject.REVIEW_DATA !== 'object') {
    return ['REVIEW_DATA must be an object with agentChecks and makerReview arrays.'];
  }
  const invalidReviewGroups = ['agentChecks', 'makerReview'].filter((group) => {
    const entries = dataObject.REVIEW_DATA[group];
    return !Array.isArray(entries) || !entries.length ||
      entries.some((entry) => typeof entry !== 'string' || !entry.trim());
  });
  if (invalidReviewGroups.length) {
    return [
      `REVIEW_DATA requires non-empty string arrays: ${invalidReviewGroups.join(', ')}`,
    ];
  }

  if (!Array.isArray(dataObject.BIDIRECTIONAL_REVIEW_DATA) ||
      !dataObject.BIDIRECTIONAL_REVIEW_DATA.length) {
    return ['BIDIRECTIONAL_REVIEW_DATA must contain every planned visible or interactive component.'];
  }
  for (let index = 0; index < dataObject.BIDIRECTIONAL_REVIEW_DATA.length; index += 1) {
    const entry = dataObject.BIDIRECTIONAL_REVIEW_DATA[index];
    const prefix = `BIDIRECTIONAL_REVIEW_DATA[${index}]`;
    for (const key of ['component', 'reason']) {
      if (typeof entry?.[key] !== 'string' || !entry[key].trim()) {
        return [`${prefix}.${key} must be a non-empty localized string.`];
      }
    }
    if (!BIDIRECTIONAL_CLASSIFICATIONS.has(entry?.classification)) {
      return [
        `${prefix}.classification must be direction-neutral, direction-aware, ` +
        'direction-fixed, or unknown-third-party.',
      ];
    }
    for (const key of ['states', 'checks']) {
      if (!Array.isArray(entry?.[key]) || !entry[key].length ||
          entry[key].some((value) => typeof value !== 'string' || !value.trim())) {
        return [`${prefix}.${key} must be a non-empty array of localized strings.`];
      }
    }
    if (!Array.isArray(entry?.viewports) || !entry.viewports.length ||
        entry.viewports.some((value) => !BIDIRECTIONAL_VIEWPORTS.has(value)) ||
        new Set(entry.viewports).size !== entry.viewports.length) {
      return [`${prefix}.viewports must contain unique desktop and/or narrow values.`];
    }
  }

  const missingLabels = requiredLabelPaths.filter((labelPath) => {
    const label = getNestedValue(dataObject.PLAN_LABELS, labelPath);
    return typeof label !== 'string' || !label.trim();
  });
  if (missingLabels.length) {
    return [`PLAN_LABELS is missing localized values: ${missingLabels.join(', ')}`];
  }

  const requiredTokens = [
    ['overview.description', '{siteName}'],
    ['overview.nextSteps.components.descriptionOne', '{count}'],
    ['overview.nextSteps.components.descriptionOther', '{count}'],
    ['overview.nextSteps.pages.descriptionOne', '{count}'],
    ['overview.nextSteps.pages.descriptionOther', '{count}'],
  ];
  const missingTokens = requiredTokens
    .filter(([labelPath, token]) => !getNestedValue(dataObject.PLAN_LABELS, labelPath).includes(token))
    .map(([labelPath, token]) => `${labelPath} (${token})`);
  return missingTokens.length
    ? [`PLAN_LABELS must preserve renderer tokens: ${missingTokens.join(', ')}`]
    : [];
}

function withDerivedTemplateData(dataObject) {
  return {
    ...dataObject,
    SUMMARY_DATA: { text: String(dataObject.SUMMARY ?? '') },
    SITE_NAME_DATA: { text: String(dataObject.SITE_NAME ?? '') },
  };
}

function render(dataObject) {
  const validationErrors = validatePlanData(dataObject);
  if (validationErrors.length) {
    console.error(`Invalid create-site plan data:\n- ${validationErrors.join('\n- ')}`);
    process.exit(1);
  }
  renderTemplate({
    templatePath,
    outputPath: path.resolve(args.output),
    dataObject: withDerivedTemplateData(dataObject),
    requiredKeys,
    escapeStringValues: true,
  });
}

if (args['data-inline']) {
  let dataObject;
  try {
    dataObject = JSON.parse(args['data-inline']);
  } catch {
    console.error('Error: --data-inline value is not valid JSON');
    process.exit(1);
  }
  render(dataObject);
} else {
  const dataPath = path.resolve(args.data);
  if (!fs.existsSync(dataPath)) {
    console.error(`Data file not found: ${dataPath}`);
    process.exit(1);
  }

  let dataObject;
  try {
    dataObject = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch {
    console.error('Error: --data file is not valid JSON');
    process.exit(1);
  }

  render(dataObject);
}
