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
  LOCALIZATION_CAPABILITIES,
  MANIFEST_NAME,
  detectLocalization,
  hasLocaleNavigationSignal,
  protectedTokenSignature,
  resolveProjectRelativePath,
  validateLocalizationManifestShape,
  validateLocales,
} = require('../../../scripts/lib/localization-config');
const {
  detectFramework,
} = require('../../../scripts/lib/framework-detection');

const MAX_REPORTED_STALE_KEYS = 20;
const MAX_DIAGNOSTIC_KEY_CHARS = 200;

function quoteDiagnosticKey(value) {
  const text = String(value);
  const bounded = text.length > MAX_DIAGNOSTIC_KEY_CHARS
    ? `${text.slice(0, MAX_DIAGNOSTIC_KEY_CHARS)}...`
    : text;
  return JSON.stringify(bounded).replace(
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function formatDiagnosticKeys(keys) {
  const reported = keys.slice(0, MAX_REPORTED_STALE_KEYS).map(quoteDiagnosticKey);
  const omitted = keys.length - reported.length;
  return `${reported.join(', ')}${omitted > 0 ? `, ... and ${omitted} more` : ''}`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
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

function resolveManifestFile(projectRoot, relativePath, label, errors) {
  const resolved = resolveProjectRelativePath(projectRoot, relativePath);
  if (!resolved.valid) {
    errors.push(
      `${label} path must be repository-relative and remain inside the project root.`
    );
    return null;
  }
  if (!fs.existsSync(resolved.path) || !fs.statSync(resolved.path).isFile()) {
    errors.push(`Missing ${label}: ${relativePath}`);
    return null;
  }
  return resolved.path;
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
    const fullPath = resolveManifestFile(
      projectRoot,
      relativePath,
      `locale resource for ${locale}`,
      errors
    );
    if (!fullPath) continue;
    const value = readJson(fullPath);
    if (value === undefined) {
      errors.push(`Locale resource is not valid JSON: ${relativePath}`);
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(
        `Locale resource must contain a top-level JSON object: ${relativePath}`
      );
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
    if (missing.length) {
      errors.push(`${locale}: missing translation keys: ${formatDiagnosticKeys(missing)}`);
    }
    if (extra.length) {
      const message =
        `${locale}: stale translation keys (untrusted project data): ` +
        formatDiagnosticKeys(extra);
      if (options.staleIsError === false) {
        options.warnings?.push(message);
      } else {
        errors.push(message);
      }
    }
    for (const key of sourceKeys.filter((candidate) => Object.hasOwn(target, candidate))) {
      const sourceTokens = protectedTokenSignature(source[key]);
      const targetTokens = protectedTokenSignature(target[key]);
      if (manifest.translationMethod === 'blank' && target[key] === '') continue;
      if (JSON.stringify(sourceTokens) !== JSON.stringify(targetTokens)) {
        errors.push(
          `${locale}:${quoteDiagnosticKey(key)}: protected interpolation/markup tokens ` +
          'do not match the default locale.'
        );
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
    const fullPath = resolveManifestFile(
      projectRoot,
      relativePath,
      `locale resource for ${locale}`,
      errors
    );
    if (!fullPath) continue;
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
    if (extra.length) {
      const message =
        `${locale}: stale XLF messages (untrusted project data): ` +
        formatDiagnosticKeys(extra);
      if (options.staleIsError === false) {
        options.warnings?.push(message);
      } else {
        errors.push(message);
      }
    }
    for (const key of sourceKeys) {
      const target = parsed[locale][key];
      if (!target) {
        errors.push(`${locale}: missing XLF message ${quoteDiagnosticKey(key)}.`);
        continue;
      }
      if (manifest.translationMethod === 'blank' && target.target === '') continue;
      if (JSON.stringify(protectedTokenSignature(source[key].source)) !==
          JSON.stringify(protectedTokenSignature(target.target))) {
        errors.push(
          `${locale}:${quoteDiagnosticKey(key)}: protected interpolation/markup tokens ` +
          'do not match the source.'
        );
      }
    }
  }
}

function validateLocalization(projectRoot, warnings = []) {
  const manifestPath = path.join(projectRoot, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
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
  if (!manifest) return [`${MANIFEST_NAME} is not valid JSON.`];
  const shapeErrors = validateLocalizationManifestShape(manifest, projectRoot);
  if (shapeErrors.length) return shapeErrors;
  const errors = [];

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
  const resolvedManagedFiles = [];
  for (const relativePath of allManagedFiles) {
    const fullPath = resolveManifestFile(
      projectRoot,
      relativePath,
      'managed localization file',
      errors
    );
    if (fullPath) resolvedManagedFiles.push(fullPath);
  }

  if (Array.isArray(manifest.locales) && manifest.locales.length >= 2) {
    const paths = Object.values(resourceMap(manifest) || {});
    const usesXlf = paths.some((relativePath) => /\.xlf\d?$/i.test(relativePath));
    const comparisonOptions = { staleIsError: false, warnings };
    if (usesXlf) compareXlfResources(projectRoot, manifest, errors, comparisonOptions);
    else compareJsonResources(projectRoot, manifest, errors, comparisonOptions);
  }

  const implementationText = resolvedManagedFiles
    .map((fullPath) => fs.readFileSync(fullPath, 'utf8'))
    .join('\n');
  if (!hasLocaleNavigationSignal(implementationText)) {
    errors.push('Managed files do not contain a language selector or locale-navigation implementation.');
  }
  if (!configuresDocumentAttribute(implementationText, 'dir')) {
    errors.push('Managed files do not configure document direction (dir).');
  }
  if (!configuresDocumentAttribute(implementationText, 'lang')) {
    errors.push('Managed files do not configure document language (lang).');
  }

  return errors;
}

function configuresDocumentAttribute(source, attribute) {
  // Accept concrete document updates such as:
  //   document.documentElement.dir = 'rtl'
  //   document.documentElement.setAttribute('lang', locale)
  //   <html lang="en-US" dir="ltr">
  // A bare `const dir = ...` or unrelated `lang` identifier is not evidence
  // that the generated site updates its root document.
  const propertyAssignment = new RegExp(
    `document\\s*\\.\\s*documentElement\\s*` +
    `(?:\\.\\s*${attribute}|\\[\\s*['"]${attribute}['"]\\s*\\])\\s*=`,
    'i'
  );
  const setAttribute = new RegExp(
    `document\\s*\\.\\s*documentElement\\s*\\.\\s*setAttribute\\s*` +
    `\\(\\s*['"]${attribute}['"]`,
    'i'
  );
  const staticHtmlAttribute = new RegExp(`<html\\b[^>]*\\b${attribute}\\s*=`, 'i');
  return propertyAssignment.test(source) ||
    setAttribute.test(source) ||
    staticHtmlAttribute.test(source);
}

function validateFrameworkModePackage(projectRoot, manifest, dependencies, detected, errors) {
  const frameworkCapability = LOCALIZATION_CAPABILITIES.frameworks[manifest.framework];
  if (frameworkCapability &&
      !frameworkCapability.supportedModes.includes(manifest.mode)) {
    errors.push(`${manifest.framework} does not support "${manifest.mode}" mode in this skill.`);
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

function finishValidation(projectRoot) {
  const warnings = [];
  const errors = validateLocalization(projectRoot, warnings);
  if (warnings.length) {
    process.stderr.write(
      `Localization validation warnings (preserved, nonblocking):\n- ${warnings.join('\n- ')}\n`
    );
  }
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
  finishValidation(path.resolve(projectRoot));
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
};
