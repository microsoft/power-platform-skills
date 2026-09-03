#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
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
  detectLocalization,
  hasLocaleNavigationSignal,
  getLocalizationModeAvailability,
  protectedTokenSignature,
  resolveProjectRelativePath,
  validateLocalizationManifestShape,
  validateLocales,
} = require('../../../scripts/lib/localization-config');
const {
  detectFramework,
} = require('../../../scripts/lib/framework-detection');
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

const MAX_REPORTED_RESOURCE_IDS = 20;
const MAX_RESOURCE_FILE_BYTES = 1024 * 1024;
const MAX_RESOURCE_ENTRIES = 10000;
const MAX_RESOURCE_DEPTH = 50;
const MAX_PACKAGE_LOCK_BYTES = 10 * 1024 * 1024;
const MAX_PROJECT_SEARCH_DEPTH = 4;
const MAX_PROJECT_SEARCH_DIRECTORIES = 500;

function diagnosticResourceId(value, prefix = 'entry') {
  const digest = crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex')
    .slice(0, 12);
  return `${prefix}#${digest}`;
}

function findLocalizationProjectRoot(cwd) {
  const ancestorRoot = findProjectRoot(cwd);
  if (ancestorRoot &&
      fs.existsSync(path.join(ancestorRoot, 'powerpages.config.json'))) {
    return ancestorRoot;
  }
  const candidates = [];
  const pending = [{ directory: path.resolve(cwd), depth: 0 }];
  let visited = 0;
  while (pending.length && visited < MAX_PROJECT_SEARCH_DIRECTORIES) {
    const { directory, depth } = pending.shift();
    visited += 1;
    if (fs.existsSync(path.join(directory, 'powerpages.config.json')) &&
        fs.existsSync(path.join(directory, MANIFEST_NAME))) {
      candidates.push(directory);
      if (candidates.length > 1) return null;
    }
    if (depth >= MAX_PROJECT_SEARCH_DEPTH) continue;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() ||
          ['.git', 'node_modules'].includes(entry.name)) {
        continue;
      }
      pending.push({
        directory: path.join(directory, entry.name),
        depth: depth + 1,
      });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function validatePackageArtifactLock(projectRoot, manifest, errors) {
  if (!manifest.packageName || manifest.packageName === 'astro-built-in') return;
  const artifact = manifest.packageVerification.artifact;
  const lockPath = path.join(projectRoot, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    errors.push(
      'npm-backed localization packages require a verified package-lock.json entry.'
    );
    return;
  }
  let lock;
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PACKAGE_LOCK_BYTES) {
      throw new Error('unsupported package lock');
    }
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    errors.push(
      'package-lock.json must be a regular JSON file no larger than 10 MiB.'
    );
    return;
  }
  const entry = lock.packages?.[`node_modules/${manifest.packageName}`] ||
    lock.dependencies?.[manifest.packageName];
  if (!entry) {
    errors.push(
      'package-lock.json is missing the configured localization package entry.'
    );
    return;
  }
  if (entry.version !== artifact.version ||
      entry.integrity !== artifact.integrity ||
      entry.resolved !== artifact.tarballUrl) {
    errors.push(
      'The localization package lock entry does not match its validated artifact provenance.'
    );
  }
}

function formatDiagnosticIds(keys, prefix = 'entry') {
  const reported = keys
    .slice(0, MAX_REPORTED_RESOURCE_IDS)
    .map((key) => diagnosticResourceId(key, prefix));
  const omitted = keys.length - reported.length;
  return `${reported.join(', ')}${omitted > 0 ? `, ... and ${omitted} more` : ''}`;
}

function readJson(filePath) {
  try {
    if (fs.statSync(filePath).size > MAX_RESOURCE_FILE_BYTES) return undefined;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function flattenJson(value, prefix = '', output = Object.create(null)) {
  const stack = [{ value, prefix, depth: 0 }];
  let entryCount = 0;
  while (stack.length) {
    const current = stack.pop();
    if (current.value && typeof current.value === 'object' &&
        !Array.isArray(current.value)) {
      if (current.depth >= MAX_RESOURCE_DEPTH) {
        throw new Error('locale resource exceeds the maximum nesting depth');
      }
      const entries = Object.entries(current.value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index];
        const childKey = current.prefix ? `${current.prefix}.${key}` : key;
        stack.push({
          value: child,
          prefix: childKey,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    entryCount += 1;
    if (entryCount > MAX_RESOURCE_ENTRIES) {
      throw new Error('locale resource exceeds the maximum entry count');
    }
    output[current.prefix] = current.value;
  }
  return output;
}

function extractXlfMessages(content) {
  const messages = Object.create(null);
  let messageCount = 0;
  const unitPattern = /<trans-unit\b[^>]*\bid=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/trans-unit>/gi;
  for (const match of content.matchAll(unitPattern)) {
    messageCount += 1;
    if (messageCount > MAX_RESOURCE_ENTRIES) {
      throw new Error('XLIFF resource exceeds the maximum message count');
    }
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
      messageCount += 1;
      if (messageCount > MAX_RESOURCE_ENTRIES) {
        throw new Error('XLIFF resource exceeds the maximum message count');
      }
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
    errors.push(
      `Missing required localization file ${diagnosticResourceId(relativePath, 'file')}.`
    );
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
    const localeId = diagnosticResourceId(locale, 'locale');
    const relativePath = resources[locale];
    if (!relativePath) {
      errors.push(`No resource path is configured for ${localeId}.`);
      continue;
    }
    const fullPath = resolveManifestFile(
      projectRoot,
      relativePath,
      `locale resource ${localeId}`,
      errors
    );
    if (!fullPath) continue;
    const value = readJson(fullPath);
    if (value === undefined) {
      errors.push(
        `Locale resource ${diagnosticResourceId(relativePath, 'file')} is invalid ` +
        `or exceeds ${MAX_RESOURCE_FILE_BYTES} bytes.`
      );
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(
        `Locale resource ${diagnosticResourceId(relativePath, 'file')} must ` +
        'contain a top-level JSON object.'
      );
      continue;
    }
    try {
      parsed[locale] = flattenJson(value);
    } catch {
      errors.push(
        `Locale resource ${diagnosticResourceId(relativePath, 'file')} exceeds ` +
        'the supported nesting or entry limits.'
      );
    }
  }

  const source = parsed[manifest.defaultLocale];
  if (!source) return;
  const sourceKeys = Object.keys(source).sort();
  for (const locale of manifest.locales) {
    if (locale === manifest.defaultLocale || !parsed[locale]) continue;
    const localeId = diagnosticResourceId(locale, 'locale');
    const target = parsed[locale];
    const targetKeys = Object.keys(target).sort();
    const missing = sourceKeys.filter((key) => !Object.hasOwn(target, key));
    const extra = targetKeys.filter((key) => !Object.hasOwn(source, key));
    if (missing.length) {
      errors.push(
        `${localeId}: missing translation entries: ${formatDiagnosticIds(missing)}`
      );
    }
    if (extra.length) {
      const message =
        `${localeId}: stale translation entries: ${formatDiagnosticIds(extra)}`;
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
          `${localeId}:${diagnosticResourceId(key)}: protected interpolation/markup tokens ` +
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
    const localeId = diagnosticResourceId(locale, 'locale');
    const relativePath = resources[locale];
    if (!relativePath) {
      errors.push(`No resource path is configured for ${localeId}.`);
      continue;
    }
    const fullPath = resolveManifestFile(
      projectRoot,
      relativePath,
      `locale resource ${localeId}`,
      errors
    );
    if (!fullPath) continue;
    if (fs.statSync(fullPath).size > MAX_RESOURCE_FILE_BYTES) {
      errors.push(
        `XLIFF resource ${diagnosticResourceId(relativePath, 'file')} exceeds ` +
        `${MAX_RESOURCE_FILE_BYTES} bytes.`
      );
      continue;
    }
    try {
      parsed[locale] = extractXlfMessages(fs.readFileSync(fullPath, 'utf8'));
    } catch {
      errors.push(
        `XLIFF resource ${diagnosticResourceId(relativePath, 'file')} exceeds ` +
        'the supported message limit.'
      );
    }
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
    const localeId = diagnosticResourceId(locale, 'locale');
    const targetKeys = Object.keys(parsed[locale]);
    if (targetKeys.length === 0) {
      errors.push(`${localeId}: XLF catalog contains no recognized messages.`);
      continue;
    }
    const extra = targetKeys.filter((key) => !Object.hasOwn(source, key));
    if (extra.length) {
      const message =
        `${localeId}: stale XLIFF messages: ${formatDiagnosticIds(extra, 'message')}`;
      if (options.staleIsError === false) {
        options.warnings?.push(message);
      } else {
        errors.push(message);
      }
    }
    for (const key of sourceKeys) {
      const target = parsed[locale][key];
      if (!target) {
        errors.push(
          `${localeId}: missing XLIFF ${diagnosticResourceId(key, 'message')}.`
        );
        continue;
      }
      if (manifest.translationMethod === 'blank' && target.target === '') continue;
      if (JSON.stringify(protectedTokenSignature(source[key].source)) !==
          JSON.stringify(protectedTokenSignature(target.target))) {
        errors.push(
          `${localeId}:${diagnosticResourceId(key, 'message')}: ` +
          'protected interpolation/markup tokens ' +
          'do not match the source.'
        );
      }
    }
  }
}

function validateLocalization(projectRoot, options = {}) {
  const warnings = options.warnings || [];
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
    return [
      `Localization evidence exists but ${MANIFEST_NAME} is missing. ` +
      'Adoption is incomplete until a validated manifest records package approvals and provenance.',
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
    projectRoot,
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
    errors.push('Manifest framework does not match the detected project framework.');
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
    errors.push('The configured localization package is not installed.');
  }
  validatePackageArtifactLock(projectRoot, manifest, errors);
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
        (availableDirectionSet.classification === 'mixed' ||
         unavailableLocales.length > 0)) {
      validateRuntimeCoordinator(projectRoot, allManagedFiles, errors);
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
  const falseStatement = String.raw`return\s+false\s*(?:;|(?=\}))`;
  const trueStatement = String.raw`return\s+true\s*(?:;|(?=\}))`;

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
      String.raw`(?:${falseStatement}|\{[^{}]*${falseStatement}[^{}]*\})\s*` +
      String.raw`(?:else\s*)?` +
      String.raw`(?:${trueStatement}|\{[^{}]*${trueStatement}[^{}]*\})`,
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
      'The locale availability module must export isLocaleAvailable, reject entries ' +
      'in unavailableLocales, and allow other configured locales.'
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
    errors.push('The configured package does not match the manifest framework and mode.');
  }

  if (manifest.packageName === 'react-i18next' && !dependencies.i18next) {
    errors.push('React localization with react-i18next also requires the i18next package.');
  }
  if (!detected.implementation.initialization) {
    errors.push('Localization initialization could not be verified.');
  }
  if (detected.implementation.initializationEvidence.provided &&
      !detected.implementation.initializationEvidence.valid) {
    errors.push('Configured localization initialization evidence is invalid.');
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
  const warnings = [];
  const errors = validateLocalization(projectRoot, {
    ...options,
    warnings,
  });
  if (warnings.length) {
    process.stderr.write(
      `Localization validation warnings (preserved, nonblocking):\n- ${warnings.join('\n- ')}\n`
    );
  }
  if (errors.length) block(`Localization validation failed:\n- ${errors.join('\n- ')}`);
  approve();
}

function finishValidationFailClosed(projectRoot, options = {}) {
  try {
    finishValidation(projectRoot, options);
  } catch {
    block(
      'Localization validation failed unexpectedly and must be reviewed before continuing.'
    );
  }
}

if (require.main === module && process.argv.includes('--projectRoot')) {
  const index = process.argv.indexOf('--projectRoot');
  const projectRoot = process.argv[index + 1];
  if (!projectRoot) {
    process.stderr.write('Usage: validate-localization.js --projectRoot <path>\n');
    process.exit(1);
  }
  finishValidationFailClosed(path.resolve(projectRoot), {
    allowActiveVerification: process.argv.includes('--verification'),
  });
} else if (require.main === module) {
  runValidation((cwd) => {
    const projectRoot = findLocalizationProjectRoot(cwd);
    if (!projectRoot) {
      block(
        'Localization validation could not identify exactly one target project.'
      );
    }
    finishValidationFailClosed(projectRoot);
  }, {
    failClosed: true,
    failureMessage:
      'Localization validation failed unexpectedly and must be reviewed before continuing.',
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
