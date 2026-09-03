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
  hasLocaleNavigationSignal,
  getLocaleDirection,
  getLocalizationModeAvailability,
  protectedTokenSignature,
  validateLocalizationManifestShape,
  validateLocales,
} = require('../../../scripts/lib/localization-config');
const {
  auditBidirectionalReadiness,
} = require('../../../scripts/lib/bidirectional-readiness');

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

function validateLocalization(projectRoot) {
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
  const shapeErrors = validateLocalizationManifestShape(manifest);
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
  if (!hasLocaleNavigationSignal(implementationText)) {
    errors.push('Managed files do not contain a language selector or locale-navigation implementation.');
  }
  if (!configuresDocumentAttribute(implementationText, 'dir')) {
    errors.push('Managed files do not configure document direction (dir).');
  }
  if (!configuresDocumentAttribute(implementationText, 'lang')) {
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
    const directionSet = classifyLocaleDirections(manifest.locales);
    if (directionSet.classification === 'mixed') {
      const bidiAudit = auditBidirectionalReadiness(projectRoot);
      const readinessPending =
        manifest.bidirectionalReadiness?.status === 'pending-remediation';
      if (!manifest.bidirectionalReadiness) {
        errors.push(
          'Mixed-direction localization requires manifest bidirectionalReadiness metadata.'
        );
      }
      const unavailableLocaleSet = new Set(unavailableLocales);
      const defaultDirection = getLocaleDirection(manifest.defaultLocale);
      const oppositeDirectionLocales = manifest.locales.filter(
        (locale) => getLocaleDirection(locale) !== defaultDirection
      );
      const allOppositeLocalesUnavailable = oppositeDirectionLocales.every(
        (locale) => unavailableLocaleSet.has(locale)
      );
      if (readinessPending && !allOppositeLocalesUnavailable) {
        errors.push(
          'Pending bidirectional remediation requires every locale opposite to the ' +
          'default direction to be unavailable.'
        );
      }
      if (readinessPending && !hasAvailabilityImplementation) {
        errors.push(
          'Pending bidirectional remediation requires managed availability logic that ' +
          'excludes each unavailable opposite-direction locale.'
        );
      }
      const canSuppressReadinessErrors =
        readinessPending &&
        allOppositeLocalesUnavailable &&
        hasAvailabilityImplementation;
      if (!canSuppressReadinessErrors) {
        for (const finding of bidiAudit.findings.filter((item) => item.severity === 'error')) {
          errors.push(
            `Bidirectional readiness ${finding.file}:${finding.line} ` +
            `[${finding.rule}]: ${finding.message}`
          );
        }
      }
      const availableLocales = manifest.locales.filter(
        (locale) => !unavailableLocaleSet.has(locale)
      );
      const availableDirectionSet = classifyLocaleDirections(availableLocales);
      if (manifest.mode === 'runtime' &&
          availableDirectionSet.classification === 'mixed') {
        validateRuntimeCoordinator(projectRoot, allManagedFiles, errors);
      }
    }
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

function readIgnoredSourceSegment(source, index) {
  const quote = source[index];
  if (quote === '"' || quote === "'" || quote === '`') {
    let escaped = false;
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      if (escaped) {
        escaped = false;
      } else if (source[cursor] === '\\') {
        escaped = true;
      } else if (source[cursor] === quote) {
        return cursor + 1;
      }
    }
    return source.length;
  }
  if (source.startsWith('//', index)) {
    const newline = source.indexOf('\n', index + 2);
    return newline < 0 ? source.length : newline;
  }
  if (source.startsWith('/*', index)) {
    const end = source.indexOf('*/', index + 2);
    return end < 0 ? source.length : end + 2;
  }
  return index;
}

function maskStringsAndComments(source) {
  let result = '';
  for (let index = 0; index < source.length;) {
    const end = readIgnoredSourceSegment(source, index);
    if (end > index) {
      // Preserve line breaks and source offsets while preventing examples in
      // comments or strings from satisfying executable-code validation.
      result += source.slice(index, end).replace(/[^\r\n]/g, ' ');
      index = end;
    } else {
      result += source[index];
      index += 1;
    }
  }
  return result;
}

function skipWhitespaceAndComments(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    const end = readIgnoredSourceSegment(source, index);
    if (end === index || !source.startsWith('/', index)) break;
    index = end;
  }
  return index;
}

function findMatchingDelimiter(source, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const end = readIgnoredSourceSegment(source, index);
    if (end > index) {
      index = end - 1;
      continue;
    }
    if (source[index] === open) depth += 1;
    if (source[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findAssignmentOperator(source, start) {
  for (let index = start; index < source.length; index += 1) {
    const end = readIgnoredSourceSegment(source, index);
    if (end > index) {
      index = end - 1;
      continue;
    }
    if (source[index] !== '=') continue;
    const previous = source[index - 1] || '';
    const next = source[index + 1] || '';
    if (next !== '=' && next !== '>' && !/[=!<>]/.test(previous)) return index;
  }
  return -1;
}

function findArrowOperator(source, start) {
  for (let index = start; index < source.length - 1; index += 1) {
    const end = readIgnoredSourceSegment(source, index);
    if (end > index) {
      index = end - 1;
      continue;
    }
    if (source.startsWith('=>', index)) return index;
  }
  return -1;
}

function findStatementEnd(source, start) {
  const delimiters = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let index = start; index < source.length; index += 1) {
    const end = readIgnoredSourceSegment(source, index);
    if (end > index) {
      index = end - 1;
      continue;
    }
    const character = source[index];
    if (delimiters[character]) {
      stack.push(delimiters[character]);
    } else if (stack.at(-1) === character) {
      stack.pop();
    } else if (character === ';' && stack.length === 0) {
      return index + 1;
    }
  }
  return source.length;
}

function extractLocaleAvailabilityImplementation(source) {
  const masked = maskStringsAndComments(source);
  const functionDeclaration =
    /\bexport\s+function\s+isLocaleAvailable\b/.exec(masked);
  if (functionDeclaration) {
    const parameters = masked.indexOf('(', functionDeclaration.index);
    if (parameters < 0) return null;
    const parametersEnd = findMatchingDelimiter(source, parameters, '(', ')');
    if (parametersEnd < 0) return null;
    const body = masked.indexOf('{', parametersEnd + 1);
    if (body < 0) return null;
    const bodyEnd = findMatchingDelimiter(source, body, '{', '}');
    if (bodyEnd < 0) return null;
    return source.slice(functionDeclaration.index, bodyEnd + 1);
  }

  const constDeclaration =
    /\bexport\s+const\s+isLocaleAvailable\b/.exec(masked);
  if (!constDeclaration) return null;
  const assignment = findAssignmentOperator(
    source,
    constDeclaration.index + constDeclaration[0].length
  );
  if (assignment < 0) return null;
  const arrow = findArrowOperator(source, assignment + 1);
  if (arrow < 0) return null;
  const body = skipWhitespaceAndComments(source, arrow + 2);
  const end = source[body] === '{'
    ? findMatchingDelimiter(source, body, '{', '}') + 1
    : findStatementEnd(source, body);
  if (end <= body) return null;
  return source.slice(constDeclaration.index, end);
}

function normalizeMembershipCalls(source) {
  const masked = maskStringsAndComments(source);
  let result = '';
  for (let index = 0; index < source.length;) {
    const identifier = 'unavailableLocales';
    const startsMembership =
      masked.startsWith(identifier, index) &&
      !/[\w$]/.test(masked[index - 1] || '') &&
      !/[\w$]/.test(masked[index + identifier.length] || '');
    if (!startsMembership) {
      result += masked[index];
      index += 1;
      continue;
    }

    let cursor = skipWhitespaceAndComments(source, index + identifier.length);
    if (source[cursor] !== '.') {
      result += masked[index];
      index += 1;
      continue;
    }
    cursor = skipWhitespaceAndComments(source, cursor + 1);
    const method = source.startsWith('includes', cursor) ? 'includes'
      : source.startsWith('has', cursor) ? 'has'
        : null;
    if (!method || /[\w$]/.test(source[cursor + method.length] || '')) {
      result += masked[index];
      index += 1;
      continue;
    }
    cursor = skipWhitespaceAndComments(source, cursor + method.length);
    if (source[cursor] !== '(') {
      result += masked[index];
      index += 1;
      continue;
    }
    const callEnd = findMatchingDelimiter(source, cursor, '(', ')');
    if (callEnd < 0) {
      result += masked[index];
      index += 1;
      continue;
    }
    result += ' __UNAVAILABLE_MEMBERSHIP__ ';
    index = callEnd + 1;
  }
  return result;
}

function rejectsUnavailableLocales(source) {
  const implementation = extractLocaleAvailabilityImplementation(source);
  if (!implementation) return false;
  const normalizedImplementation = normalizeMembershipCalls(implementation);
  const normalizedSource = normalizeMembershipCalls(source);
  const membership = '__UNAVAILABLE_MEMBERSHIP__';
  const returnedExpression = String.raw`(?:return\s+|=>\s*)`;

  // Generated and subsequently refactored projects can express the same boolean
  // contract in several forms. Keep this allowlist narrow so a direct, inverted
  // membership result does not accidentally validate.
  const directRejections = [
    new RegExp(String.raw`${returnedExpression}!\s*${membership}`),
    new RegExp(
      String.raw`${returnedExpression}${membership}\s*` +
      String.raw`(?:={2,3}\s*false|!={1,2}\s*true)`
    ),
    new RegExp(
      String.raw`${returnedExpression}(?:false\s*={2,3}|true\s*!={1,2})\s*` +
      membership
    ),
    new RegExp(
      String.raw`${returnedExpression}${membership}\s*\?\s*false\s*:\s*true`
    ),
    new RegExp(
      String.raw`if\s*\(\s*${membership}\s*\)\s*` +
      String.raw`(?:return\s+false\b|\{[^{}]*\breturn\s+false\b[^{}]*\})`,
      's'
    ),
  ];
  if (directRejections.some((pattern) => pattern.test(normalizedImplementation))) {
    return true;
  }

  // Also allow the common refactor where membership is wrapped in a clearly named
  // positive helper and isLocaleAvailable returns its negation.
  for (const helper of ['isLocaleUnavailable', 'isUnavailableLocale']) {
    const helperDefinition = new RegExp(
      String.raw`(?:function\s+${helper}\s*\([^)]*\)\s*\{[^{}]*` +
      String.raw`\breturn\s+${membership}|` +
      String.raw`const\s+${helper}\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*` +
      String.raw`=>\s*${membership})`,
      's'
    );
    const availabilityNegatesHelper = new RegExp(
      String.raw`${returnedExpression}!\s*${helper}\s*\(`
    );
    if (helperDefinition.test(normalizedSource) &&
        availabilityNegatesHelper.test(normalizedImplementation)) {
      return true;
    }
  }
  return false;
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
      'Unavailable locales require one managed locale availability module.'
    );
    return false;
  }

  const availabilityPath = availabilityPaths[0];
  const fullAvailabilityPath = path.join(projectRoot, availabilityPath);
  if (!fs.existsSync(fullAvailabilityPath)) return false;
  const availabilitySource = fs.readFileSync(fullAvailabilityPath, 'utf8');
  let valid = true;
  if (!/\bexport\s+(?:function|const)\s+isLocaleAvailable\b/.test(availabilitySource) ||
      !rejectsUnavailableLocales(availabilitySource)) {
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
  for (const { relativePath, source } of boundaryFiles) {
    if (!/\bisLocaleAvailable\s*\(|\bfilter\s*\(\s*isLocaleAvailable\b/.test(source)) {
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

function finishValidation(projectRoot) {
  const errors = validateLocalization(projectRoot);
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
  validateRuntimeCoordinator,
};
