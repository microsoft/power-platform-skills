#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  approve,
  block,
  findProjectRoot,
  runValidation,
} = require('../../../scripts/lib/validation-helpers');
const {
  KNOWN_PACKAGES,
  MANIFEST_NAME,
  classifyLocaleDirections,
  detectFramework,
  detectLocalization,
  getLocalizationModeAvailability,
  protectedTokenSignature,
  validateLocalizationManifestShape,
  validateLocales,
} = require('../../../scripts/lib/localization-config');
const {
  auditBidirectionalReadiness,
} = require('../../../scripts/lib/bidirectional-readiness');
const {
  partitionDeferredFindings,
} = require('../../../scripts/lib/bidirectional-finding-disposition');
const {
  listVerificationTransactionArtifacts,
  readLocalizationVerificationTransaction,
  validateTransactionAgainstManifest,
} = require('../../../scripts/lib/localization-verification-transaction');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function flattenJson(value, prefix = '', output = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childKey = prefix ? `${prefix}.${key}` : key;
      flattenJson(child, childKey, output);
    }
    return output;
  }
  output[prefix] = value;
  return output;
}

function extractXlfMessages(content) {
  const messages = {};
  const unitPattern = /<trans-unit\b[^>]*\bid=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/trans-unit>/gi;
  for (const match of content.matchAll(unitPattern)) {
    const body = match[3];
    const source = body.match(/<source(?:\s[^>]*)?>([\s\S]*?)<\/source>/i)?.[1] || '';
    const target = body.match(/<target(?:\s[^>]*)?>([\s\S]*?)<\/target>/i)?.[1] || '';
    messages[match[1] || match[2]] = { source, target };
  }
  const unit2Pattern = /<unit\b[^>]*\bid=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/unit>/gi;
  for (const match of content.matchAll(unit2Pattern)) {
    const unitId = match[1] || match[2];
    const segments = [...match[3].matchAll(/<segment\b([^>]*)>([\s\S]*?)<\/segment>/gi)];
    for (const [index, segment] of segments.entries()) {
      const segmentId = segment[1].match(/\bid=(?:"([^"]+)"|'([^']+)')/i);
      const key = segments.length === 1
        ? unitId
        : `${unitId}#${segmentId?.[1] || segmentId?.[2] || index + 1}`;
      const source = segment[2].match(
        /<source(?:\s[^>]*)?>([\s\S]*?)<\/source>/i
      )?.[1] || '';
      const target = segment[2].match(
        /<target(?:\s[^>]*)?>([\s\S]*?)<\/target>/i
      )?.[1] || '';
      messages[key] = { source, target };
    }
  }
  return messages;
}

function resourceMap(manifest) {
  if (!manifest.resourcePaths || typeof manifest.resourcePaths !== 'object' ||
      Array.isArray(manifest.resourcePaths)) return null;
  return manifest.resourcePaths;
}

function compareJsonResources(projectRoot, manifest, errors, options = {}) {
  const resources = resourceMap(manifest);
  if (!resources) {
    errors.push('Manifest resourcePaths must map each locale to a resource file path.');
    return;
  }

  const parsed = {};
  for (const locale of manifest.locales) {
    const relativePath = resources[locale];
    if (!relativePath) {
      errors.push(`No resource path is configured for locale ${locale}.`);
      continue;
    }
    const fullPath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      errors.push(`Missing locale resource: ${relativePath}`);
      continue;
    }
    const value = readJson(fullPath);
    if (!value) {
      errors.push(`Locale resource is not valid JSON: ${relativePath}`);
      continue;
    }
    parsed[locale] = flattenJson(value);
  }

  const source = parsed[manifest.defaultLocale];
  if (!source) return;
  const sourceKeys = Object.keys(source).sort();
  for (const locale of manifest.locales) {
    if (locale === manifest.defaultLocale || !parsed[locale]) continue;
    const target = parsed[locale];
    const targetKeys = Object.keys(target).sort();
    const missing = sourceKeys.filter((key) => !Object.hasOwn(target, key));
    const extra = targetKeys.filter((key) => !Object.hasOwn(source, key));
    if (missing.length) errors.push(`${locale}: missing translation keys: ${missing.join(', ')}`);
    if (extra.length && options.staleIsError !== false) {
      errors.push(`${locale}: stale translation keys: ${extra.join(', ')}`);
    }
    for (const key of sourceKeys.filter((candidate) => Object.hasOwn(target, candidate))) {
      const sourceTokens = protectedTokenSignature(source[key]);
      const targetTokens = protectedTokenSignature(target[key]);
      if (manifest.translationMethod === 'blank' && target[key] === '') continue;
      if (JSON.stringify(sourceTokens) !== JSON.stringify(targetTokens)) {
        errors.push(`${locale}:${key}: protected interpolation/markup tokens do not match the default locale.`);
      }
    }
  }
}

function compareXlfResources(projectRoot, manifest, errors, options = {}) {
  const resources = resourceMap(manifest);
  if (!resources) {
    errors.push('Manifest resourcePaths must map each locale to an XLF file path.');
    return;
  }
  const parsed = {};
  for (const locale of manifest.locales) {
    const relativePath = resources[locale];
    if (!relativePath) {
      errors.push(`No resource path is configured for locale ${locale}.`);
      continue;
    }
    const fullPath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      errors.push(`Missing locale resource: ${relativePath}`);
      continue;
    }
    parsed[locale] = extractXlfMessages(fs.readFileSync(fullPath, 'utf8'));
  }

  const source = parsed[manifest.defaultLocale];
  if (!source) return;
  const sourceKeys = Object.keys(source);
  if (sourceKeys.length === 0) {
    errors.push('Default-locale XLF catalog contains no recognized messages.');
    return;
  }
  for (const locale of manifest.locales) {
    if (locale === manifest.defaultLocale || !parsed[locale]) continue;
    const targetKeys = Object.keys(parsed[locale]);
    if (targetKeys.length === 0) {
      errors.push(`${locale}: XLF catalog contains no recognized messages.`);
      continue;
    }
    const extra = targetKeys.filter((key) => !Object.hasOwn(source, key));
    if (extra.length && options.staleIsError !== false) {
      errors.push(`${locale}: stale XLF messages: ${extra.join(', ')}`);
    }
    for (const key of sourceKeys) {
      const target = parsed[locale][key];
      if (!target) {
        errors.push(`${locale}: missing XLF message ${key}.`);
        continue;
      }
      if (manifest.translationMethod === 'blank' && target.target === '') continue;
      if (JSON.stringify(protectedTokenSignature(source[key].source)) !==
          JSON.stringify(protectedTokenSignature(target.target))) {
        errors.push(`${locale}:${key}: protected interpolation/markup tokens do not match the source.`);
      }
    }
  }
}

function validateLocalization(projectRoot, options = {}) {
  const manifestPath = path.join(projectRoot, MANIFEST_NAME);
  const transactionResult =
    readLocalizationVerificationTransaction(projectRoot);
  const transactionArtifacts = listVerificationTransactionArtifacts(projectRoot);
  const earlyTransactionErrors = [...transactionResult.errors];
  for (const artifact of transactionArtifacts) {
    if (artifact !== '.powerpages-localization-verification.json') {
      earlyTransactionErrors.push(
        `Localization verification transaction candidate ${artifact} remains ` +
        'in the project.'
      );
    }
  }
  if (!fs.existsSync(manifestPath)) {
    if (transactionResult.transaction || earlyTransactionErrors.length > 0) {
      return [
        ...earlyTransactionErrors,
        'Localization verification cannot continue or complete without a valid manifest.',
      ];
    }
    const detected = detectLocalization(projectRoot);
    if (!detected.detected) return [];
    if (detected.valid) {
      const framework = detectFramework(projectRoot);
      const inferredManifest = {
        framework: framework.framework,
        mode: detected.mode,
        packageName: detected.packageName,
        locales: detected.locales,
        defaultLocale: detected.defaultLocale,
        translationMethod: 'agent',
        resourcePaths: detected.resourcePaths,
      };
      const resourceErrors = [];
      const paths = Object.values(detected.resourcePaths);
      const usesXlf = paths.some((relativePath) => /\.xlf\d?$/i.test(relativePath));
      if (usesXlf) compareXlfResources(projectRoot, inferredManifest, resourceErrors);
      else compareJsonResources(projectRoot, inferredManifest, resourceErrors);
      if (!resourceErrors.length) return [];
      return [
        `Localization evidence exists but ${MANIFEST_NAME} is missing and the resources are not safe to adopt.`,
        ...resourceErrors,
      ];
    }
    return [
      `Localization evidence exists but ${MANIFEST_NAME} is missing and the setup is incomplete.`,
      ...detected.conflicts,
    ];
  }

  const manifest = readJson(manifestPath);
  if (!manifest) {
    return [
      ...earlyTransactionErrors,
      ...(transactionResult.transaction
        ? ['Localization verification is blocked until the manifest is restored.']
        : []),
      `${MANIFEST_NAME} is not valid JSON.`,
    ];
  }
  const errors = [];
  errors.push(...earlyTransactionErrors);
  const transaction = transactionResult.errors.length === 0
    ? transactionResult.transaction
    : null;
  const allowActiveVerification =
    options.allowActiveVerification === true &&
    transaction?.state === 'in-progress';
  const shapeErrors = validateLocalizationManifestShape(manifest, {
    verificationLocales: allowActiveVerification
      ? transaction.targetLocales
      : [],
  });
  if (shapeErrors.length) return [...errors, ...shapeErrors];
  if (options.allowActiveVerification === true && !transaction) {
    errors.push(
      'Phase 6 verification requires an active localization verification transaction.'
    );
  } else if (options.allowActiveVerification === true &&
      transaction?.state !== 'in-progress') {
    errors.push(
      'The localization verification transaction requires remediation before testing.'
    );
  } else if (transaction &&
      options.allowActiveVerification !== true &&
      options.allowTransactionFinalization !== true) {
    errors.push(
      'Localization verification is still active. Reconcile the target locales ' +
      'and finalize the transaction before completing or deploying the site.'
    );
  }
  if (allowActiveVerification) {
    errors.push(...validateTransactionAgainstManifest(
      transaction,
      manifest,
      { requireExposed: true }
    ));
  }
  for (const finding of [
    ...(manifest.bidirectionalReadiness?.findings || []),
    ...(manifest.bidirectionalReadiness?.renderedFindings || []),
  ]) {
    const evidence = finding?.disposition?.evidence;
    if (!evidence) continue;
    const evidencePath = path.resolve(projectRoot, evidence);
    const evidenceRoot = path.resolve(projectRoot, 'docs', 'bidirectional-evidence');
    if (!evidencePath.startsWith(`${evidenceRoot}${path.sep}`) ||
        !fs.existsSync(evidencePath) ||
        !fs.statSync(evidencePath).isFile()) {
      errors.push(
        `Maker-approved bidirectional limitation evidence does not exist: ${evidence}`
      );
    }
  }

  if (manifest.schemaVersion !== 1) errors.push('Manifest schemaVersion must be 1.');
  const frameworkDetection = detectFramework(projectRoot);
  const selectedFramework = frameworkDetection.framework ||
    (frameworkDetection.ambiguous &&
      frameworkDetection.candidates.includes(manifest.framework)
      ? manifest.framework
      : null);
  if (!selectedFramework) {
    errors.push('Project framework is ambiguous or unsupported.');
  } else if (selectedFramework !== manifest.framework) {
    errors.push(
      `Manifest framework "${manifest.framework}" does not match detected framework "${selectedFramework}".`
    );
  }
  if (!['runtime', 'static'].includes(manifest.mode)) {
    errors.push('Manifest mode must be "runtime" or "static".');
  }
  if (!['agent', 'blank'].includes(manifest.translationMethod)) {
    errors.push('Manifest translationMethod must be "agent" or "blank".');
  }
  if (!Array.isArray(manifest.locales) || manifest.locales.length < 2) {
    errors.push('Manifest must contain at least two locales.');
  } else {
    const validation = validateLocales(manifest.locales);
    if (!validation.valid || validation.duplicates.length ||
        validation.canonicalization.length ||
        validation.locales.length !== manifest.locales.length) {
      errors.push('Manifest locales must be valid, canonical, and unique BCP-47 tags.');
    }
    if (!manifest.locales.includes(manifest.defaultLocale)) {
      errors.push('Manifest defaultLocale must be one of the configured locales.');
    }
    if (Array.isArray(manifest.unavailableLocales)) {
      const unavailableValidation = validateLocales(manifest.unavailableLocales);
      if (!unavailableValidation.valid || unavailableValidation.duplicates.length ||
          unavailableValidation.canonicalization.length ||
          unavailableValidation.locales.length !== manifest.unavailableLocales.length) {
        errors.push(
          'Manifest unavailableLocales must be valid, canonical, and unique BCP-47 tags.'
        );
      }
      for (const locale of manifest.unavailableLocales) {
        if (!manifest.locales.includes(locale)) {
          errors.push(`Unavailable locale ${locale} must also appear in manifest locales.`);
        }
        if (locale === manifest.defaultLocale) {
          errors.push('Manifest defaultLocale cannot be unavailable.');
        }
      }
    }
  }

  const packageJson = readJson(path.join(projectRoot, 'package.json')) || {};
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  if (manifest.packageName && manifest.packageName !== 'astro-built-in' &&
      !dependencies[manifest.packageName]) {
    errors.push(`Configured localization package "${manifest.packageName}" is not installed.`);
  }
  validateFrameworkModePackage(
    projectRoot,
    manifest,
    dependencies,
    detectLocalization(projectRoot),
    errors
  );

  const allManagedFiles = [
    ...(manifest.generatedFiles || []),
    ...(manifest.managedFiles || []),
  ];
  for (const relativePath of allManagedFiles) {
    if (!fs.existsSync(path.join(projectRoot, relativePath))) {
      errors.push(`Missing managed localization file: ${relativePath}`);
    }
  }

  if (Array.isArray(manifest.locales) && manifest.locales.length >= 2) {
    const paths = Object.values(resourceMap(manifest) || {});
    const usesXlf = paths.some((relativePath) => /\.xlf\d?$/i.test(relativePath));
    const comparisonOptions = { staleIsError: false };
    if (usesXlf) compareXlfResources(projectRoot, manifest, errors, comparisonOptions);
    else compareJsonResources(projectRoot, manifest, errors, comparisonOptions);
  }

  const implementationText = allManagedFiles
    .filter((relativePath) => fs.existsSync(path.join(projectRoot, relativePath)))
    .map((relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'))
    .join('\n');
  if (!/LanguageSelector|language selector|locale-switcher|switchLanguage|changeLanguage/i.test(implementationText)) {
    errors.push('Managed files do not contain a language selector or locale-navigation implementation.');
  }
  if (!/\bdir\b|documentElement\.dir|setAttribute\(['"]dir/i.test(implementationText)) {
    errors.push('Managed files do not configure document direction (dir).');
  }
  if (!/\blang\b|documentElement\.lang|setAttribute\(['"]lang/i.test(implementationText)) {
    errors.push('Managed files do not configure document language (lang).');
  }

  const unavailableLocales = Array.isArray(manifest.unavailableLocales)
    ? manifest.unavailableLocales
    : [];
  const hasAvailabilityImplementation = unavailableLocales.length > 0
    ? validateLocaleAvailability(
      projectRoot,
      allManagedFiles,
      unavailableLocales,
      errors
    )
    : true;

  if (Array.isArray(manifest.locales) && manifest.locales.length >= 2) {
    const bidiAudit = auditBidirectionalReadiness(projectRoot);
    const { blocking, unmatchedRecorded } = partitionDeferredFindings(
      bidiAudit.findings,
      manifest.bidirectionalReadiness?.findings || [],
      unavailableLocales
    );
    for (const finding of unmatchedRecorded) {
      errors.push(
        `Recorded bidirectional finding ${finding.file}:${finding.line} ` +
        `[${finding.rule}] no longer exactly matches the source audit. ` +
        'Rerun the audit and remove or replace the stale manifest finding.'
      );
    }
    for (const finding of blocking) {
      errors.push(
        `Bidirectional readiness ${finding.file}:${finding.line} ` +
        `[${finding.rule}]: ${finding.message}`
      );
    }
    if (unavailableLocales.length > 0 && !hasAvailabilityImplementation) {
      errors.push(
        'Pending bidirectional remediation requires managed availability logic ' +
        'that excludes each unavailable locale.'
      );
    }
    const unavailableLocaleSet = new Set(unavailableLocales);
    const availableLocales = manifest.locales.filter(
      (locale) => !unavailableLocaleSet.has(locale)
    );
    const availableDirectionSet = classifyLocaleDirections(availableLocales);
    if (manifest.mode === 'runtime' &&
        availableDirectionSet.classification === 'mixed') {
      validateRuntimeCoordinator(projectRoot, allManagedFiles, errors);
    }
  }

  return errors;
}

function validateLocaleAvailability(
  projectRoot,
  allManagedFiles,
  unavailableLocales,
  errors
) {
  const availabilityPaths = allManagedFiles.filter((relativePath) =>
    /locale[-_.]?availability/i.test(path.basename(relativePath))
  );
  if (availabilityPaths.length !== 1) {
    errors.push(
      'Pending bidirectional remediation requires one managed locale availability module.'
    );
    return false;
  }

  const availabilityPath = availabilityPaths[0];
  const fullAvailabilityPath = path.join(projectRoot, availabilityPath);
  if (!fs.existsSync(fullAvailabilityPath)) return false;
  const availabilitySource = fs.readFileSync(fullAvailabilityPath, 'utf8');
  let valid = true;
  if (!/\bexport\s+(?:function|const)\s+isLocaleAvailable\b/.test(availabilitySource) ||
      !/!\s*unavailableLocales\.(?:has|includes)\s*\(/.test(availabilitySource)) {
    errors.push(
      'The locale availability module must export isLocaleAvailable and reject ' +
      'entries in unavailableLocales.'
    );
    valid = false;
  }
  for (const locale of unavailableLocales) {
    if (!availabilitySource.includes(locale)) {
      errors.push(`Locale availability module does not exclude ${locale}.`);
      valid = false;
    }
  }

  const boundaryPattern =
    /LanguageSelector|language selector|locale-switcher|switchLanguage|changeLanguage|navigator\.languages?|\bhreflang\b|rel\s*=\s*['"]alternate|(?:^|\W)locales?\s*:/im;
  const boundaryFiles = allManagedFiles
    .filter((relativePath) => relativePath !== availabilityPath)
    .filter((relativePath) => fs.existsSync(path.join(projectRoot, relativePath)))
    .map((relativePath) => ({
      relativePath,
      source: fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'),
    }))
    .filter(({ source }) => boundaryPattern.test(source));
  const filteredLocaleCollection =
    /\.filter\s*\(\s*(?:isLocaleAvailable\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*isLocaleAvailable\s*\()/s;
  const guardedLocaleCandidate =
    /if\s*\(\s*!\s*isLocaleAvailable\s*\([^)]+\)\s*\)\s*(?:\{[^}]*\b(?:return|continue)\b|(?:return|continue)\b)/s;
  for (const { relativePath, source } of boundaryFiles) {
    const exposesSelector =
      /LanguageSelector|language selector|locale-switcher/i.test(source);
    const filtersEveryUnavailableSelectorLocale = unavailableLocales.every((locale) => {
      const escaped = locale.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(
        `\\[[^\\]]*['"]${escaped}['"][^\\]]*\\]\\s*` +
        '\\.filter\\s*\\(\\s*(?:isLocaleAvailable\\b|' +
        '(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*' +
        'isLocaleAvailable\\s*\\()',
        's'
      ).test(source);
    });
    const appliesAvailability = exposesSelector
      ? filtersEveryUnavailableSelectorLocale
      : filteredLocaleCollection.test(source) ||
        guardedLocaleCandidate.test(source);
    if (!appliesAvailability) {
      errors.push(
        `Locale activation boundary ${relativePath} does not apply isLocaleAvailable.`
      );
      valid = false;
    }
  }
  if (boundaryFiles.length === 0) {
    errors.push(
      'Managed files do not expose a locale activation boundary that applies availability.'
    );
    valid = false;
  }
  return valid;
}

function collectProjectFiles(projectRoot, includeFile) {
  const excludedDirectories = new Set([
    '.git',
    '.powerpages-site',
    'build',
    'coverage',
    'dist',
    'docs',
    'node_modules',
  ]);
  const files = [];
  const pending = [projectRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) pending.push(fullPath);
      } else if (entry.isFile() && includeFile(entry)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function validateRuntimeCoordinator(projectRoot, allManagedFiles, errors) {
  const coordinatorPaths = allManagedFiles.filter((relativePath) =>
    /locale[-_.]?coordinator/i.test(path.basename(relativePath))
  );
  if (coordinatorPaths.length !== 1) {
    errors.push(
      'Mixed-direction runtime localization requires one managed locale coordinator file.'
    );
    return;
  }

  const [coordinatorPath] = coordinatorPaths;
  const fullPath = path.join(projectRoot, coordinatorPath);
  if (!fs.existsSync(fullPath)) return;
  const source = fs.readFileSync(fullPath, 'utf8');
  const requirements = [
    [/switchLocale/i, 'an exported or public switchLocale operation'],
    [
      /document\.documentElement\.(?:lang|setAttribute\(['"]lang)/i,
      'document language updates',
    ],
    [
      /document\.documentElement\.(?:dir|setAttribute\(['"]dir)/i,
      'document direction updates',
    ],
    [
      /changeLanguage|setActiveLang|locale\.value|activeLocale/i,
      'localization-library activation',
    ],
    [/localStorage/i, 'locale preference persistence'],
  ];
  for (const [pattern, description] of requirements) {
    if (!pattern.test(source)) {
      errors.push(`Locale coordinator ${coordinatorPath} is missing ${description}.`);
    }
  }
  const localeDerivedDirection =
    /document\.documentElement\.dir\s*=\s*(?!['"](?:ltr|rtl)['"]\s*;)[^;\n]*(?:locale|direction|dirBy|resolve|getLocale)/i.test(
      source
    ) ||
    /document\.documentElement\.setAttribute\(\s*['"]dir['"]\s*,\s*(?!['"](?:ltr|rtl)['"]\s*\))[^)\n]*(?:locale|direction|dirBy|resolve|getLocale)/i.test(
      source
    );
  if (!localeDerivedDirection) {
    errors.push(
      `Locale coordinator ${coordinatorPath} must derive document direction from ` +
      'the selected locale instead of assigning a fixed direction.'
    );
  }
}

function validateFrameworkModePackage(projectRoot, manifest, dependencies, detected, errors) {
  const modeAvailability = getLocalizationModeAvailability(
    manifest.framework,
    manifest.mode
  );
  if (!modeAvailability.available) {
    errors.push(modeAvailability.reason);
  }
  for (const evidence of detected.unavailableModeEvidence || []) {
    if (evidence.mode === manifest.mode) continue;
    const availability = getLocalizationModeAvailability(
      manifest.framework,
      evidence.mode
    );
    errors.push(
      `${availability.reason} Remove or migrate detected ${evidence.detail} ` +
      'before validation can pass.'
    );
  }

  const knownPackage = KNOWN_PACKAGES[manifest.packageName];
  if (knownPackage && (knownPackage.framework !== manifest.framework ||
      knownPackage.mode !== manifest.mode)) {
    errors.push(
      `Package "${manifest.packageName}" is for ${knownPackage.framework} ` +
      `${knownPackage.mode} localization, not ${manifest.framework} ${manifest.mode}.`
    );
  }

  if (manifest.packageName === 'react-i18next' && !dependencies.i18next) {
    errors.push('React localization with react-i18next also requires the i18next package.');
  }
  if (!detected.implementation.initialization) {
    errors.push('Localization initialization could not be verified.');
  }
  if (detected.implementation.initializationEvidence.provided &&
      !detected.implementation.initializationEvidence.valid) {
    errors.push(detected.implementation.initializationEvidence.reason);
  }
  if (manifest.framework === 'angular' && manifest.mode === 'static' && !detected.angularI18n) {
    errors.push('Angular static localization is missing angular.json i18n configuration.');
  }
  if (manifest.framework === 'astro') {
    if (manifest.packageName !== 'astro-built-in') {
      errors.push('Astro static localization must use packageName "astro-built-in".');
    }
    if (!detected.astroConfig) {
      errors.push('Astro localization is missing i18n configuration in the Astro config file.');
    }
    const pagesRoot = path.join(projectRoot, 'src', 'pages');
    const hasDynamicLocaleRoute = ['[lang]', '[locale]']
      .some((directory) => fs.existsSync(path.join(pagesRoot, directory)));
    const hasTargetLocaleRoute = (manifest.locales || [])
      .filter((locale) => locale !== manifest.defaultLocale)
      .some((locale) => fs.existsSync(path.join(pagesRoot, locale)));
    if (!hasDynamicLocaleRoute && !hasTargetLocaleRoute) {
      errors.push('Astro localization is missing locale-specific or dynamic locale routes.');
    }
  }

}

function finishValidation(projectRoot, options = {}) {
  const errors = validateLocalization(projectRoot, options);
  if (errors.length) block(`Localization validation failed:\n- ${errors.join('\n- ')}`);
  approve();
}

if (require.main === module && process.argv.includes('--projectRoot')) {
  const index = process.argv.indexOf('--projectRoot');
  const projectRoot = process.argv[index + 1];
  if (!projectRoot) {
    process.stderr.write('Usage: validate-localization.js --projectRoot <path>\n');
    process.exit(1);
  }
  finishValidation(path.resolve(projectRoot), {
    allowActiveVerification: process.argv.includes('--verification'),
  });
} else if (require.main === module) {
  runValidation((cwd) => {
    const projectRoot = findProjectRoot(cwd);
    if (!projectRoot) approve();
    finishValidation(projectRoot);
  });
}

module.exports = {
  compareJsonResources,
  compareXlfResources,
  extractXlfMessages,
  flattenJson,
  validateManifestShape: validateLocalizationManifestShape,
  validateFrameworkModePackage,
  validateLocalization,
  validateRuntimeCoordinator,
};
