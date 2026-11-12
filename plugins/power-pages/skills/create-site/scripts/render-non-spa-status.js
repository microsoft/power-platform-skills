#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  renderTemplate,
  parseArgs,
} = require('../../../scripts/lib/render-template');
const {
  normalizeNonSpaModelVersion,
} = require('../../../scripts/lib/site-templates');
const {
  loadNonSpaTemplatePresentation,
} = require('../../../scripts/lib/non-spa-template-catalog');
const {
  CLOUD_TO_SITE_DOMAIN,
} = require('../../../scripts/lib/validation-helpers');

const ACTIVITY_STATES = new Set(['working', 'awaiting-input', 'failed', 'canceled']);

const STATUSES = Object.freeze({
  accepted: {
    step: 0,
    chip: 'Request accepted',
    title: 'Creation request accepted',
    message:
      'Power Pages accepted the request. No action is required while the platform prepares the site.',
  },
  provisioning: {
    step: 1,
    chip: 'Provisioning',
    title: 'Provisioning the selected template',
    message: 'The asynchronous creation operation is assembling the platform-managed components.',
  },
  registration: {
    step: 2,
    chip: 'Registering',
    title: 'Waiting for the website record',
    message: 'Provisioning completed. The website is still propagating to Dataverse and PAC.',
  },
  verification: {
    step: 3,
    chip: 'Verifying',
    title: 'Verifying the selected data model',
    message: 'The website record is available. PAC is confirming that the expected model was created.',
  },
  download: {
    step: 4,
    chip: 'Downloading',
    title: 'Downloading your site',
    message: 'The site is ready for PAC. Its non-SPA pages, forms, navigation, and settings are downloading.',
  },
  validation: {
    step: 5,
    chip: 'Validating',
    title: 'Validating the downloaded baseline',
    message: 'The downloaded identity, non-SPA assets, and project structure are being checked.',
  },
  git: {
    step: 5,
    chip: 'Saving baseline',
    title: 'Saving a clean starting point',
    message: 'The validated template is being recorded as the initial Git baseline.',
  },
  ready: {
    step: 6,
    chip: 'Ready',
    title: 'Your site is ready',
    message: 'The downloaded baseline and cloud site are ready for customization.',
    terminal: true,
    result: {
      title: 'Creation complete',
      message: 'Data model verified · Site downloaded · Validation passed · Git baseline created',
    },
  },
  'model-mismatch': {
    step: 3,
    chip: 'Action required',
    title: 'The site was created with a different data model',
    message: 'PAC reports a different model than selected. The cloud site is preserved, but download stopped to prevent using the wrong model.',
    terminal: true,
    error: true,
    result: {
      title: 'No duplicate site will be created',
      message: 'Review the environment setting, keep the existing website record, and resume verification later.',
    },
  },
});

const TIMELINE = Object.freeze([
  ['Request accepted', 'The platform returned 202 Accepted'],
  ['Template provisioning', 'The asynchronous operation is running'],
  ['Website registration', 'Waiting for the service-assigned website ID'],
  ['Data model verification', 'Checking the site with PAC'],
  ['Template download', 'Downloading non-SPA site assets'],
  ['Local validation', 'Checking identity, assets, and project structure; saving the Git baseline'],
]);

function toDataUrl(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = extension === '.png' ? 'image/png' : 'application/octet-stream';
  return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function validateWebsiteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--siteUrl must be a valid absolute URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('--siteUrl must use HTTPS without embedded credentials');
  }
  return url.href;
}

function validatePlainTextOption(name, value, options = {}) {
  const text = String(value || '').trim();
  if (options.required && !text) {
    throw new Error(`${name} is required`);
  }
  if (!text) return '';
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${name} must be plain single-line text`);
  }
  const maxLength = options.maxLength || 500;
  if (text.length > maxLength) {
    throw new Error(`${name} must be ${maxLength} characters or fewer`);
  }
  return text;
}

function buildModel(options, template) {
  const modelVersion = normalizeNonSpaModelVersion(options.modelVersion);
  const actualModelVersion = options.actualModelVersion
    ? normalizeNonSpaModelVersion(options.actualModelVersion)
    : null;
  if (!template || template.name !== options.templateName) {
    throw new Error(`Catalog metadata does not match --templateName: ${options.templateName}`);
  }

  const status = STATUSES[options.status];
  if (!status) {
    throw new Error(`Unsupported --status: ${options.status}`);
  }
  const siteDomain = CLOUD_TO_SITE_DOMAIN[options.cloud];
  if (!siteDomain) {
    throw new Error(
      `Unsupported --cloud: ${options.cloud}. Use ${Object.keys(CLOUD_TO_SITE_DOMAIN).join(', ')}.`,
    );
  }
  const explicitSiteUrl = options.siteUrl ? validateWebsiteUrl(options.siteUrl) : null;
  if (options.status === 'ready' && !explicitSiteUrl) {
    throw new Error('--siteUrl is required when --status is ready');
  }
  if (!Number.isInteger(Number(options.language)) || Number(options.language) <= 0) {
    throw new Error('--language must be a positive integer LCID');
  }
  const resolvedStatus = {
    ...status,
    message:
      options.status === 'model-mismatch'
        ? `PAC reports ${actualModelVersion || 'a different model'} instead of ` +
          `${modelVersion}. The cloud site is preserved, but download stopped to prevent using ` +
          'the wrong model.'
        : status.message,
    result: status.result
      ? {
          ...status.result,
          message:
            options.status === 'ready'
              ? `${modelVersion} model verified · Site downloaded · Validation passed · ` +
                'Git baseline created'
              : status.result.message,
        }
      : undefined,
  };
  const defaultActivityState =
    options.status === 'ready' ? 'complete' : status.error ? 'failed' : 'working';
  const activityState = options.activityState || defaultActivityState;
  if (
    activityState !== 'complete' &&
    !ACTIVITY_STATES.has(activityState)
  ) {
    throw new Error(
      `Unsupported --activityState: ${activityState}. ` +
        'Use working, awaiting-input, failed, or canceled.',
    );
  }
  if (activityState === 'complete' && options.activityState) {
    throw new Error('--activityState complete is derived from --status ready and cannot be set directly');
  }
  if (status.terminal && activityState === 'working') {
    throw new Error(`--status ${options.status} cannot use --activityState working`);
  }
  if (
    options.status === 'ready' &&
    (activityState === 'failed' || activityState === 'canceled')
  ) {
    throw new Error(
      `--status ready cannot use --activityState ${activityState}; ` +
        'the completed site remains ready when optional follow-up work stops.',
    );
  }
  if (activityState === 'awaiting-input' && !String(options.requiredAction || '').trim()) {
    throw new Error('--requiredAction is required when --activityState is awaiting-input');
  }
  if (
    activityState !== 'awaiting-input' &&
    (options.requiredAction || options.responseLocation)
  ) {
    throw new Error(
      '--requiredAction and --responseLocation are only valid with --activityState awaiting-input',
    );
  }

  const awaitingInput = activityState === 'awaiting-input';
  const failed = activityState === 'failed';
  const canceled = activityState === 'canceled';
  const genericTerminalActivity =
    (failed || canceled) && options.status !== 'model-mismatch';
  const terminalReason = validatePlainTextOption(
    '--terminalReason',
    options.terminalReason,
    { required: genericTerminalActivity, maxLength: 500 },
  );
  const nextAction = validatePlainTextOption(
    '--nextAction',
    options.nextAction,
    { required: genericTerminalActivity, maxLength: 300 },
  );
  if (!genericTerminalActivity && (terminalReason || nextAction)) {
    throw new Error(
      '--terminalReason and --nextAction are only valid with a generic failed or canceled activity',
    );
  }
  if (genericTerminalActivity) {
    resolvedStatus.result = {
      title: failed ? 'Creation stopped' : 'Creation canceled',
      message: terminalReason,
      nextAction,
    };
    resolvedStatus.message = terminalReason;
    resolvedStatus.error = failed;
  } else if (options.status === 'model-mismatch') {
    resolvedStatus.result = {
      ...resolvedStatus.result,
      nextAction:
        'Confirm the environment data-model setting, then resume verification of this existing site.',
    };
  }
  const terminal = !awaitingInput && (status.terminal || failed || canceled);
  const activityChip = awaitingInput
    ? 'Input needed'
    : failed
      ? 'Creation stopped'
      : canceled
        ? 'Canceled'
        : resolvedStatus.chip;

  const pluginRoot = path.resolve(__dirname, '..', '..', '..');
  const brandIcon = toDataUrl(
    path.join(pluginRoot, 'skills', 'create-site', 'assets', 'shared', 'power-pages-icon.png'),
  );
  return {
    brandIcon,
    template: {
      name: template.name,
      displayName: template.displayName,
      description: template.description,
      capabilities: template.capabilities || [],
      requirements: template.requirements || [],
      warning: template.warning || '',
      previews: template.previews || [],
      catalog: template.catalog,
    },
    site: {
      name: options.siteName,
      url: explicitSiteUrl || `https://${options.subdomain}.${siteDomain}`,
      language: {
        source: 'Organization default',
        name: validatePlainTextOption('--languageName', options.languageName, {
          required: true,
          maxLength: 100,
        }),
        code: validatePlainTextOption('--languageCode', options.languageCode, {
          maxLength: 35,
        }),
        lcid: String(options.language),
      },
      websiteRecordId: options.websiteRecordId || '',
      modelVersion,
    },
    status: {
      key: options.status,
      ...resolvedStatus,
      chip: activityChip,
      activityState,
      terminal,
      openWebsiteUrl: options.status === 'ready' ? explicitSiteUrl : null,
      footer:
        options.status === 'model-mismatch'
          ? 'The cloud site is preserved. Resolve the data-model setting before resuming verification and download.'
          : failed
          ? 'Creation stopped before a usable local baseline was ready. Follow the next action above before retrying.'
          : canceled
            ? 'Creation was canceled. Any cloud resource or local files already created are preserved.'
            : options.status === 'ready' && !awaitingInput
                ? 'Creation is complete. You can keep this page open while you begin customizing the downloaded site.'
                : null,
      notification: awaitingInput
        ? {
            title: 'Your input is needed',
            requiredAction: String(options.requiredAction).trim(),
            responseLocation:
              String(options.responseLocation || '').trim() ||
              'Return to the site creation conversation and provide your response.',
          }
        : null,
    },
    timeline: TIMELINE,
    refresh: !terminal,
  };
}

async function renderStatusPage(options, deps = {}) {
  if (
    !options.templateName ||
    !options.catalogOwner ||
    !options.catalogRepo ||
    !options.catalogSha ||
    !options.modelVersion ||
    !options.status ||
    !options.siteName ||
    !options.subdomain ||
    !options.cloud ||
    !options.language ||
    !options.languageName
  ) {
    throw new Error(
      'Usage: render-non-spa-status.js [--output <path>] --templateName <name> ' +
      '--catalogOwner <owner> --catalogRepo <repo> --catalogSha <sha> ' +
      '--modelVersion <Enhanced|Standard> --status <status> ' +
      '--siteName <name> --subdomain <subdomain> --cloud <cloud> ' +
      '--language <lcid> --languageName <name> [--languageCode <code>] [--siteUrl <url>] ' +
      '[--websiteRecordId <guid>] [--actualModelVersion <Enhanced|Standard>] ' +
      '[--activityState <working|awaiting-input|failed|canceled>] ' +
      '[--requiredAction <text>] [--responseLocation <text>] ' +
      '[--terminalReason <text> --nextAction <text>]',
    );
  }

  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(
        os.tmpdir(),
        'power-platform-skills',
        'create-site',
        options.subdomain.replace(/[^a-z0-9-]/gi, '-'),
        'status.html',
      );
  const loadTemplate = deps.loadNonSpaTemplatePresentation ||
    loadNonSpaTemplatePresentation;
  const template = await loadTemplate({
    owner: options.catalogOwner,
    repo: options.catalogRepo,
    sha: options.catalogSha,
    templateName: options.templateName,
    cacheRoot: options.cacheRoot,
  }, deps);
  const model = buildModel(options, template);
  renderTemplate({
    templatePath: path.join(__dirname, '..', 'assets', 'non-spa-creation-status-template.html'),
    outputPath,
    dataObject: {
      MODEL: model,
      CSP_IMAGE_SOURCES: 'data:',
      CSP_CONNECT_SOURCES: "'none'",
    },
    requiredKeys: ['MODEL', 'CSP_IMAGE_SOURCES', 'CSP_CONNECT_SOURCES'],
    overwrite: true,
    emitStatus: false,
  });

  return {
    status: 'ok',
    output: outputPath,
    url: pathToFileURL(outputPath).href,
    creationStatus: options.status,
  };
}

async function main() {
  try {
    const result = await renderStatusPage(parseArgs(process.argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ACTIVITY_STATES,
  STATUSES,
  TIMELINE,
  buildModel,
  renderStatusPage,
  validatePlainTextOption,
  validateWebsiteUrl,
};
