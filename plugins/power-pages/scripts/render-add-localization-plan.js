#!/usr/bin/env node
/**
 * Renders the add-localization implementation plan.
 *
 * The HTML artifact is human-readable approval evidence only. Later phases use
 * the approved in-memory configuration and the final localization manifest,
 * not this document, as their source of truth.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');
const {
  KNOWN_PACKAGES,
  getLocalizationModeAvailability,
  resolveLocale,
} = require('./lib/localization-config');

const args = parseArgs(process.argv);

if (!args.output || (!args['data-inline'] && !args.data)) {
  console.error(
    'Usage: node render-add-localization-plan.js --output <path> --data-inline \'<json>\'\n' +
    '       node render-add-localization-plan.js --output <path> --data <json-file>'
  );
  process.exit(1);
}

const templatePath = path.join(
  __dirname,
  '..',
  'skills',
  'add-localization',
  'assets',
  'add-localization-plan.html'
);

const requiredKeys = [
  'SITE_NAME',
  'PLAN_TITLE',
  'SOURCE_LANGUAGE',
  'SOURCE_LOCALE',
  'SOURCE_DIRECTION',
  'FRAMEWORK',
  'INVOCATION_CONTEXT',
  'OPERATION',
  'EXISTING_LOCALIZATION_DETECTED',
  'SUMMARY',
  'PLAN_LABELS',
  'DISCOVERY_DATA',
  'CONFIGURATION_DATA',
  'LOCALES_DATA',
  'FILES_DATA',
  'READINESS_DATA',
  'VALIDATION_DATA',
  'LIMITATIONS_DATA',
];

const requiredLabelPaths = [
  'navigation.group',
  'navigation.overview',
  'navigation.languages',
  'navigation.changes',
  'navigation.readiness',
  'navigation.verification',
  'overview.title',
  'overview.description',
  'overview.framework',
  'overview.invocation',
  'overview.operation',
  'overview.existingSetup',
  'overview.configuration',
  'overview.frameworkEvidence',
  'overview.existingDetails',
  'overview.conflicts',
  'overview.noConflicts',
  'configuration.package',
  'configuration.mode',
  'configuration.defaultLocale',
  'configuration.translation',
  'configuration.selector',
  'configuration.verification',
  'configuration.selection',
  'configuration.evidenceSource',
  'configuration.evidence',
  'configuration.initialization',
  'configuration.rootRepair',
  'languages.title',
  'languages.description',
  'languages.language',
  'languages.locale',
  'languages.direction',
  'languages.roles',
  'languages.availability',
  'changes.title',
  'changes.description',
  'changes.path',
  'changes.action',
  'changes.reason',
  'readiness.title',
  'readiness.description',
  'readiness.transition',
  'readiness.findings',
  'readiness.noFindings',
  'readiness.location',
  'readiness.rule',
  'readiness.remediation',
  'readiness.physicalExceptions',
  'readiness.scriptFonts',
  'readiness.unavailableLocales',
  'readiness.none',
  'verification.title',
  'verification.description',
  'verification.checks',
  'verification.limitations',
  'verification.noLimitations',
  'status.new',
  'status.preserved',
  'status.changed',
  'status.create',
  'status.update',
  'status.preserve',
  'status.replace',
  'status.skip',
  'status.source',
  'status.default',
  'status.existing',
  'status.added',
  'status.available',
  'status.pendingRemediation',
  'status.verified',
  'status.unverified',
  'status.yes',
  'status.no',
  'packageSelection.recommended',
  'packageSelection.alternative',
  'packageSelection.preserved',
  'evidenceSource.knownCapability',
  'evidenceSource.packageDocumentation',
  'evidenceSource.officialDocumentation',
  'evidenceSource.userApproved',
  'severity.error',
  'severity.review',
  'operation.create',
  'operation.addLanguages',
  'operation.repair',
  'operation.reconfigure',
  'invocation.direct',
  'invocation.createSite',
  'footer.aiWarning',
];

const CHANGE_STATUSES = new Set(['new', 'preserved', 'changed']);
const FILE_ACTIONS = new Set(['create', 'update', 'preserve', 'replace', 'skip']);
const LOCALE_ROLES = new Set(['source', 'default', 'existing', 'added']);
const AVAILABILITY = new Set(['available', 'pending-remediation']);
const OPERATIONS = new Set(['create', 'add-languages', 'repair', 'reconfigure']);
const INVOCATIONS = new Set(['direct', 'create-site']);
const PACKAGE_SELECTIONS = new Set(['recommended', 'alternative', 'preserved']);
const EVIDENCE_SOURCES = new Set([
  'known-capability',
  'package-documentation',
  'official-documentation',
  'user-approved',
]);
const TRANSLATION_METHODS = new Set(['agent', 'blank']);
const REQUIRED_VALIDATION_IDS = [
  'independent-validator',
  'project-build',
  'package-initialization',
  'resource-completeness',
  'protected-tokens',
  'locale-navigation',
  'locale-state',
  'fallback-behavior',
  'document-lang-dir',
  'browser-console',
  'representative-routes',
  'bidirectional-content',
  'localized-formatting',
  'script-fonts',
  'directional-components',
  'accessibility',
];

function getNestedValue(value, dottedPath) {
  return dottedPath.split('.').reduce(
    (current, key) => current && current[key],
    value
  );
}

function validateString(value, name, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${name} must be a non-empty string.`);
  }
}

function validatePlanData(data) {
  const errors = [];
  for (const key of ['SITE_NAME', 'PLAN_TITLE', 'SOURCE_LANGUAGE', 'SUMMARY']) {
    validateString(data[key], key, errors);
  }
  if (!['React', 'Vue', 'Angular', 'Astro'].includes(data.FRAMEWORK)) {
    errors.push('FRAMEWORK must be React, Vue, Angular, or Astro.');
  }
  const source = resolveLocale(data.SOURCE_LOCALE);
  if (!source.valid || !source.locale) {
    errors.push(`SOURCE_LOCALE must be a valid BCP-47 locale: ${data.SOURCE_LOCALE}`);
  } else {
    if (source.locale !== data.SOURCE_LOCALE) {
      errors.push(`SOURCE_LOCALE must be canonical BCP-47. Use "${source.locale}".`);
    }
    if (source.direction !== data.SOURCE_DIRECTION) {
      errors.push(
        `SOURCE_DIRECTION "${data.SOURCE_DIRECTION}" does not match ` +
        `${source.locale}, which resolves to "${source.direction}".`
      );
    }
  }

  if (!OPERATIONS.has(data.OPERATION)) {
    errors.push('OPERATION must be create, add-languages, repair, or reconfigure.');
  }
  if (!INVOCATIONS.has(data.INVOCATION_CONTEXT)) {
    errors.push('INVOCATION_CONTEXT must be direct or create-site.');
  }
  if (typeof data.EXISTING_LOCALIZATION_DETECTED !== 'boolean') {
    errors.push('EXISTING_LOCALIZATION_DETECTED must be boolean.');
  }

  const discovery = data.DISCOVERY_DATA;
  if (!discovery || Array.isArray(discovery) || typeof discovery !== 'object') {
    errors.push('DISCOVERY_DATA must be an object.');
  } else {
    for (const key of ['frameworkEvidence', 'existingSetup', 'conflicts']) {
      if (!Array.isArray(discovery[key]) ||
          discovery[key].some((entry) => typeof entry !== 'string' || !entry.trim())) {
        errors.push(`DISCOVERY_DATA.${key} must be an array of non-empty strings.`);
      }
    }
    if (!discovery.frameworkEvidence?.length) {
      errors.push('DISCOVERY_DATA.frameworkEvidence must not be empty.');
    }
  }

  const missingLabels = requiredLabelPaths.filter((labelPath) => {
    const label = getNestedValue(data.PLAN_LABELS, labelPath);
    return typeof label !== 'string' || !label.trim();
  });
  if (missingLabels.length) {
    errors.push(`PLAN_LABELS is missing localized values: ${missingLabels.join(', ')}`);
  } else if (!getNestedValue(data.PLAN_LABELS, 'overview.description').includes('{siteName}')) {
    errors.push('PLAN_LABELS.overview.description must preserve {siteName}.');
  }

  const config = data.CONFIGURATION_DATA;
  if (!config || Array.isArray(config) || typeof config !== 'object') {
    errors.push('CONFIGURATION_DATA must be an object.');
  } else {
    for (const key of ['package', 'mode', 'defaultLocale']) {
      const item = config[key];
      if (!item || typeof item !== 'object') {
        errors.push(`CONFIGURATION_DATA.${key} must be an object.`);
        continue;
      }
      validateString(item.value, `CONFIGURATION_DATA.${key}.value`, errors);
      if (!CHANGE_STATUSES.has(item.status)) {
        errors.push(
          `CONFIGURATION_DATA.${key}.status must be new, preserved, or changed.`
        );
      }
    }
    if (typeof data.FRAMEWORK === 'string' &&
        typeof config.mode?.value === 'string') {
      const availability = getLocalizationModeAvailability(
        data.FRAMEWORK.toLowerCase(),
        config.mode.value
      );
      if (!availability.available) {
        errors.push(availability.reason);
      }
    }
    if (config.package && typeof config.package === 'object') {
      validateString(config.package.name, 'CONFIGURATION_DATA.package.name', errors);
      validateString(config.package.version, 'CONFIGURATION_DATA.package.version', errors);
      const knownPackage = KNOWN_PACKAGES[config.package.name];
      if (knownPackage && typeof data.FRAMEWORK === 'string' &&
          typeof config.mode?.value === 'string' &&
          (knownPackage.framework !== data.FRAMEWORK.toLowerCase() ||
           knownPackage.mode !== config.mode.value)) {
        errors.push(
          `Package "${config.package.name}" is for ${knownPackage.framework} ` +
          `${knownPackage.mode} localization, not ` +
          `${data.FRAMEWORK.toLowerCase()} ${config.mode.value}.`
        );
      }
    }
    for (const key of ['translation', 'selector']) {
      if (!config[key] || typeof config[key] !== 'object') {
        errors.push(`CONFIGURATION_DATA.${key} must be an object.`);
      } else {
        validateString(
          config[key].value,
          `CONFIGURATION_DATA.${key}.value`,
          errors
        );
        validateString(
          config[key].description,
          `CONFIGURATION_DATA.${key}.description`,
          errors
        );
        if ('status' in config[key]) {
          errors.push(`CONFIGURATION_DATA.${key} must not define status.`);
        }
      }
    }
    if (config.translation && !TRANSLATION_METHODS.has(config.translation.method)) {
      errors.push('CONFIGURATION_DATA.translation.method must be agent or blank.');
    }
    if (config.translation?.method === 'agent') {
      validateString(
        config.translation.warning,
        'CONFIGURATION_DATA.translation.warning',
        errors
      );
    }
    if (config.package && !['verified', 'unverified'].includes(config.package.verification)) {
      errors.push('CONFIGURATION_DATA.package.verification must be verified or unverified.');
    }
    if (config.package && !PACKAGE_SELECTIONS.has(config.package.selection)) {
      errors.push(
        'CONFIGURATION_DATA.package.selection must be recommended, alternative, or preserved.'
      );
    }
    if (config.package && !EVIDENCE_SOURCES.has(config.package.evidenceSource)) {
      errors.push('CONFIGURATION_DATA.package.evidenceSource is invalid.');
    }
    if (config.package?.verification === 'unverified' &&
        config.package?.evidenceSource !== 'user-approved') {
      errors.push(
        'An unverified package must use evidenceSource "user-approved".'
      );
    }
    if (config.package?.evidenceSource === 'official-documentation' &&
        !config.package?.evidenceUrl) {
      errors.push(
        'Official-documentation package evidence requires an HTTPS evidenceUrl.'
      );
    }
    if (config.package?.evidenceUrl !== undefined &&
        !/^https:\/\//i.test(config.package.evidenceUrl)) {
      errors.push('CONFIGURATION_DATA.package.evidenceUrl must be an HTTPS URL.');
    }
    if (config.package?.initializationEvidence !== null &&
        config.package?.initializationEvidence !== undefined) {
      const evidence = config.package.initializationEvidence;
      if (!evidence || typeof evidence !== 'object') {
        errors.push('CONFIGURATION_DATA.package.initializationEvidence must be null or an object.');
      } else {
        validateString(
          evidence.file,
          'CONFIGURATION_DATA.package.initializationEvidence.file',
          errors
        );
        validateString(
          evidence.marker,
          'CONFIGURATION_DATA.package.initializationEvidence.marker',
          errors
        );
      }
    }
    if (config.rootDocumentRepair !== null &&
        config.rootDocumentRepair !== undefined) {
      const repair = config.rootDocumentRepair;
      if (!repair || typeof repair !== 'object') {
        errors.push('CONFIGURATION_DATA.rootDocumentRepair must be null or an object.');
      } else {
        validateString(repair.file, 'CONFIGURATION_DATA.rootDocumentRepair.file', errors);
        validateString(repair.lang, 'CONFIGURATION_DATA.rootDocumentRepair.lang', errors);
        if (!['ltr', 'rtl'].includes(repair.dir)) {
          errors.push('CONFIGURATION_DATA.rootDocumentRepair.dir must be ltr or rtl.');
        } else {
          const repairLocale = resolveLocale(repair.lang);
          if (!repairLocale.valid || repairLocale.locale !== repair.lang ||
              repairLocale.direction !== repair.dir) {
            errors.push(
              'CONFIGURATION_DATA.rootDocumentRepair lang/dir must be a canonical matching locale pair.'
            );
          }
        }
      }
    }
  }

  if (!Array.isArray(data.LOCALES_DATA) || data.LOCALES_DATA.length < 2) {
    errors.push('LOCALES_DATA must contain at least two locale entries.');
  } else {
    let sourceCount = 0;
    let defaultCount = 0;
    const localeTags = [];
    for (const [index, localeEntry] of data.LOCALES_DATA.entries()) {
      const prefix = `LOCALES_DATA[${index}]`;
      const resolved = resolveLocale(localeEntry?.locale);
      validateString(localeEntry?.language, `${prefix}.language`, errors);
      if (!resolved.valid || !resolved.locale || resolved.locale !== localeEntry?.locale) {
        errors.push(`${prefix}.locale must be a canonical BCP-47 locale.`);
      } else if (resolved.direction !== localeEntry.direction) {
        errors.push(`${prefix}.direction does not match ${resolved.locale}.`);
      } else {
        localeTags.push(resolved.locale);
      }
      if (new Set(localeTags).size !== localeTags.length) {
        errors.push('LOCALES_DATA must not contain duplicate locale tags.');
      }
      if (!Array.isArray(localeEntry?.roles) || !localeEntry.roles.length ||
          localeEntry.roles.some((role) => !LOCALE_ROLES.has(role))) {
        errors.push(`${prefix}.roles contains an invalid or empty role set.`);
      } else {
        if (new Set(localeEntry.roles).size !== localeEntry.roles.length) {
          errors.push(`${prefix}.roles must not contain duplicates.`);
        }
        const lifecycleRoles = localeEntry.roles.filter(
          (role) => role === 'existing' || role === 'added'
        );
        if (lifecycleRoles.length !== 1) {
          errors.push(`${prefix}.roles must identify exactly one of existing or added.`);
        }
        if (localeEntry.roles.includes('source')) sourceCount += 1;
        if (localeEntry.roles.includes('default')) defaultCount += 1;
      }
      if (!AVAILABILITY.has(localeEntry?.availability)) {
        errors.push(`${prefix}.availability must be available or pending-remediation.`);
      }
    }
    if (sourceCount !== 1) errors.push('LOCALES_DATA must identify exactly one source locale.');
    if (defaultCount !== 1) errors.push('LOCALES_DATA must identify exactly one default locale.');
    const sourceEntry = data.LOCALES_DATA.find((entry) => entry.roles?.includes('source'));
    if (sourceEntry && sourceEntry.locale !== data.SOURCE_LOCALE) {
      errors.push('SOURCE_LOCALE must match the locale with the source role.');
    }
    if (sourceEntry && sourceEntry.availability !== 'available') {
      errors.push('The source locale must remain available.');
    }
    if (sourceEntry && !sourceEntry.roles.includes('existing')) {
      errors.push('The source locale must use the existing role, not added.');
    }
    const defaultEntry = data.LOCALES_DATA.find((entry) => entry.roles?.includes('default'));
    if (defaultEntry && config?.defaultLocale?.value !== defaultEntry.locale) {
      errors.push('CONFIGURATION_DATA.defaultLocale.value must match the default locale role.');
    }
  }

  if (!Array.isArray(data.FILES_DATA) || !data.FILES_DATA.length) {
    errors.push('FILES_DATA must contain at least one file or package change.');
  } else {
    data.FILES_DATA.forEach((entry, index) => {
      validateString(entry?.path, `FILES_DATA[${index}].path`, errors);
      validateString(entry?.reason, `FILES_DATA[${index}].reason`, errors);
      if (!FILE_ACTIONS.has(entry?.action)) {
        errors.push(`FILES_DATA[${index}].action is invalid.`);
      }
    });
  }

  const readiness = data.READINESS_DATA;
  if (!readiness || Array.isArray(readiness) || typeof readiness !== 'object') {
    errors.push('READINESS_DATA must be an object.');
  } else {
    validateString(readiness.transition, 'READINESS_DATA.transition', errors);
    for (const key of ['findings', 'physicalExceptions', 'scriptFonts', 'unavailableLocales']) {
      if (!Array.isArray(readiness[key])) {
        errors.push(`READINESS_DATA.${key} must be an array.`);
      }
    }
    if (Array.isArray(readiness.findings)) {
      readiness.findings.forEach((finding, index) => {
        const prefix = `READINESS_DATA.findings[${index}]`;
        if (!['error', 'review'].includes(finding?.severity)) {
          errors.push(`${prefix}.severity must be error or review.`);
        }
        for (const key of ['file', 'rule', 'message']) {
          validateString(finding?.[key], `${prefix}.${key}`, errors);
        }
        if (!Number.isInteger(finding?.line) || finding.line < 1) {
          errors.push(`${prefix}.line must be a positive integer.`);
        }
        validateString(finding?.remediation, `${prefix}.remediation`, errors);
      });
    }
    for (const key of ['physicalExceptions', 'scriptFonts', 'unavailableLocales']) {
      if (Array.isArray(readiness[key]) &&
          readiness[key].some((entry) => typeof entry !== 'string' || !entry.trim())) {
        errors.push(`READINESS_DATA.${key} must contain only non-empty strings.`);
      }
    }
    if (Array.isArray(readiness.unavailableLocales) && Array.isArray(data.LOCALES_DATA)) {
      const expectedUnavailable = data.LOCALES_DATA
        .filter((entry) => entry.availability === 'pending-remediation')
        .map((entry) => entry.locale)
        .sort();
      const actualUnavailable = [...readiness.unavailableLocales].sort();
      if (JSON.stringify(expectedUnavailable) !== JSON.stringify(actualUnavailable)) {
        errors.push(
          'READINESS_DATA.unavailableLocales must match locales marked pending-remediation.'
        );
      }
    }
  }

  if (!Array.isArray(data.VALIDATION_DATA)) {
    errors.push('VALIDATION_DATA must be an array.');
  } else {
    const ids = [];
    data.VALIDATION_DATA.forEach((entry, index) => {
      validateString(entry?.id, `VALIDATION_DATA[${index}].id`, errors);
      validateString(
        entry?.description,
        `VALIDATION_DATA[${index}].description`,
        errors
      );
      if (typeof entry?.id === 'string') ids.push(entry.id);
    });
    if (new Set(ids).size !== ids.length) {
      errors.push('VALIDATION_DATA ids must be unique.');
    }
    const missingValidation = REQUIRED_VALIDATION_IDS.filter((id) => !ids.includes(id));
    if (missingValidation.length) {
      errors.push(
        `VALIDATION_DATA is missing required checks: ${missingValidation.join(', ')}`
      );
    }
  }
  if (!Array.isArray(data.LIMITATIONS_DATA) ||
      data.LIMITATIONS_DATA.some(
        (entry) => typeof entry !== 'string' || !entry.trim()
      )) {
    errors.push('LIMITATIONS_DATA must be an array of non-empty strings.');
  }

  return errors;
}

function withDerivedData(data) {
  return {
    ...data,
    SITE_NAME_DATA: { text: String(data.SITE_NAME ?? '') },
    SUMMARY_DATA: { text: String(data.SUMMARY ?? '') },
    META_DATA: {
      framework: data.FRAMEWORK,
      invocationContext: data.INVOCATION_CONTEXT,
      operation: data.OPERATION,
      existingLocalizationDetected: data.EXISTING_LOCALIZATION_DETECTED,
    },
  };
}

function render(data) {
  const errors = validatePlanData(data);
  if (errors.length) {
    console.error(`Invalid add-localization plan data:\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }

  renderTemplate({
    templatePath,
    outputPath: path.resolve(args.output),
    dataObject: withDerivedData(data),
    requiredKeys,
    escapeStringValues: true,
  });
}

if (args['data-inline']) {
  try {
    render(JSON.parse(args['data-inline']));
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error('Error: --data-inline value is not valid JSON');
      process.exit(1);
    }
    throw error;
  }
} else {
  const dataPath = path.resolve(args.data);
  if (!fs.existsSync(dataPath)) {
    console.error(`Data file not found: ${dataPath}`);
    process.exit(1);
  }
  try {
    render(JSON.parse(fs.readFileSync(dataPath, 'utf8')));
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error('Error: --data file is not valid JSON');
      process.exit(1);
    }
    throw error;
  }
}
