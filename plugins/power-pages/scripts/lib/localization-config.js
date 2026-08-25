#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  detectFramework,
  packageDependencies,
} = require('./framework-detection');
const {
  AUTOMATICALLY_ACCEPTED_LICENSES,
} = require('./package-license-policy');
const {
  isSafeBoundedText,
  sanitizeUntrustedText,
} = require('./safe-untrusted-text');

const MANIFEST_NAME = '.powerpages-localization.json';
const MAX_MODE_EVIDENCE_ENTRIES = 10;
const REGISTRY_PATH = path.join(__dirname, '..', '..', 'references', 'bcp47-subtags.json');
const LOCALE_NAVIGATION_PATTERN =
  /LanguageSelector|language selector|locale-switcher|switchLanguage|changeLanguage|setActiveLang|setLocale|getRelativeLocaleUrl|hreflang/i;

function hasLocaleNavigationSignal(text) {
  return LOCALE_NAVIGATION_PATTERN.test(String(text || ''));
}

const LOCALIZATION_CAPABILITIES = Object.freeze({
  frameworks: Object.freeze({
    react: Object.freeze({
      supportedModes: Object.freeze(['runtime']),
      recommendedMode: 'runtime',
      recommendedPackages: Object.freeze({ runtime: 'react-i18next' }),
      frameworkPeers: Object.freeze(['react', 'react-dom']),
    }),
    vue: Object.freeze({
      supportedModes: Object.freeze(['runtime']),
      recommendedMode: 'runtime',
      recommendedPackages: Object.freeze({ runtime: 'vue-i18n' }),
      frameworkPeers: Object.freeze(['vue']),
    }),
    angular: Object.freeze({
      supportedModes: Object.freeze(['runtime', 'static']),
      recommendedMode: 'static',
      recommendedPackages: Object.freeze({
        runtime: '@jsverse/transloco',
        static: '@angular/localize',
      }),
      frameworkPeers: Object.freeze([
        '@angular/core',
        '@angular/compiler',
        '@angular/compiler-cli',
      ]),
    }),
    astro: Object.freeze({
      supportedModes: Object.freeze(['static']),
      recommendedMode: 'static',
      recommendedPackages: Object.freeze({ static: 'astro-built-in' }),
      frameworkPeers: Object.freeze(['astro']),
    }),
  }),
  packages: Object.freeze({
    i18next: Object.freeze({ framework: 'react', mode: 'runtime', auxiliary: true }),
    'react-i18next': Object.freeze({ framework: 'react', mode: 'runtime' }),
    'vue-i18n': Object.freeze({ framework: 'vue', mode: 'runtime' }),
    '@angular/localize': Object.freeze({ framework: 'angular', mode: 'static' }),
    '@jsverse/transloco': Object.freeze({ framework: 'angular', mode: 'runtime' }),
    'astro-built-in': Object.freeze({ framework: 'astro', mode: 'static', builtIn: true }),
  }),
});
const KNOWN_PACKAGES = LOCALIZATION_CAPABILITIES.packages;
const DEFAULT_SOURCE_SCAN_LIMITS = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
});
const MANIFEST_FIELDS = Object.freeze(new Set([
  'schemaVersion',
  'framework',
  'mode',
  'packageName',
  'packageVersion',
  'packageVerification',
  'locales',
  'defaultLocale',
  'translationMethod',
  'resourcePaths',
  'generatedFiles',
  'managedFiles',
  'unavailableLocales',
  'bidirectionalReadiness',
  'adoptedExistingConfiguration',
  'lastOperation',
  'updatedAt',
  'initializationEvidence',
]));
const PACKAGE_VERIFICATION_FIELDS = Object.freeze(new Set([
  'status',
  'source',
  'evidenceUrl',
  'requestedMode',
  'classification',
  'explanation',
  'evidence',
  'supportConditions',
  'license',
  'licenseReview',
  'artifact',
]));
const MODE_EVIDENCE_FIELDS = Object.freeze(new Set(['quote', 'explanation']));
const PACKAGE_ARTIFACT_FIELDS = Object.freeze(new Set([
  'version',
  'registry',
  'tarballUrl',
  'integrity',
]));
const NPM_PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

let cachedRegistry;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative));
}

function repositoryRelativePathError(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return 'must be a non-empty path';
  }
  if (relativePath.includes('\0')) {
    return 'must not contain null bytes';
  }
  // Treat both separator styles as path syntax on every platform. Otherwise,
  // a Windows-style traversal can look like a harmless filename on Linux CI.
  const portablePath = relativePath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(portablePath) || path.win32.isAbsolute(relativePath)) {
    return 'must be repository-relative';
  }
  const normalized = path.posix.normalize(portablePath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return 'must remain inside the project root';
  }
  return null;
}

function resolveProjectRelativePath(projectRoot, relativePath) {
  const syntaxError = repositoryRelativePathError(relativePath);
  if (syntaxError) {
    return { valid: false, reason: syntaxError, path: null };
  }

  const resolvedRoot = path.resolve(projectRoot);
  const portablePath = relativePath.replace(/[\\/]/g, path.sep);
  const resolvedPath = path.resolve(resolvedRoot, portablePath);
  if (!isPathInside(resolvedRoot, resolvedPath)) {
    return {
      valid: false,
      reason: 'must remain inside the project root',
      path: null,
    };
  }

  // A missing final path can still escape through an existing symlinked
  // ancestor (for example, src -> C:\outside followed by src\new.json).
  // Resolve the nearest existing ancestor before callers read or create it.
  const canonicalRoot = fs.realpathSync(resolvedRoot);
  let existingAncestor = resolvedPath;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const canonicalAncestor = fs.realpathSync(existingAncestor);
  if (!isPathInside(canonicalRoot, canonicalAncestor)) {
    return {
      valid: false,
      reason: 'must not resolve outside the project root',
      path: null,
    };
  }

  return { valid: true, reason: null, path: resolvedPath };
}

function validateManifestPath(errors, field, relativePath, projectRoot) {
  const result = projectRoot
    ? resolveProjectRelativePath(projectRoot, relativePath)
    : { valid: !repositoryRelativePathError(relativePath) };
  if (!result.valid) {
    errors.push(
      `Manifest ${field} path must be repository-relative ` +
      'and remain inside the project root.'
    );
  }
}

function hasOnlyAllowedProperties(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateLocalizationManifestShape(manifest, projectRoot) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['Localization manifest must be a JSON object.'];
  }
  const errors = [];
  if (!hasOnlyAllowedProperties(manifest, MANIFEST_FIELDS)) {
    errors.push('Localization manifest contains unsupported top-level properties.');
  }
  if (typeof manifest.schemaVersion !== 'number') {
    errors.push('Manifest schemaVersion must be a number.');
  }
  for (const [field, maxChars] of Object.entries({
    framework: 50,
    mode: 20,
    packageName: 214,
    packageVersion: 200,
    defaultLocale: 100,
    translationMethod: 20,
    lastOperation: 50,
    updatedAt: 100,
  })) {
    if (!isSafeBoundedText(manifest[field], maxChars)) {
      errors.push(
        `Manifest ${field} must be a non-empty string of at most ${maxChars} ` +
        'characters without control characters.'
      );
    }
  }
  if (isSafeBoundedText(manifest.packageName, 214) &&
      manifest.packageName !== 'astro-built-in' &&
      !NPM_PACKAGE_NAME_PATTERN.test(manifest.packageName)) {
    errors.push('Manifest packageName must be a valid lowercase npm package name.');
  }
  for (const field of ['locales', 'generatedFiles', 'managedFiles']) {
    if (!Array.isArray(manifest[field]) ||
        manifest[field].some((value) => !isSafeBoundedText(value, 500))) {
      errors.push(
        `Manifest ${field} must be an array of non-empty strings of at most 500 ` +
        'characters without control characters.'
      );
    } else if (field !== 'locales') {
      for (const relativePath of manifest[field]) {
        validateManifestPath(errors, field, relativePath, projectRoot);
      }
    }
  }
  if (!manifest.resourcePaths || typeof manifest.resourcePaths !== 'object' ||
      Array.isArray(manifest.resourcePaths) ||
      Object.values(manifest.resourcePaths).some(
        (value) => !isSafeBoundedText(value, 500)
      )) {
    errors.push(
      'Manifest resourcePaths must be an object whose values are non-empty paths ' +
      'of at most 500 characters without control characters.'
    );
  } else {
    for (const relativePath of Object.values(manifest.resourcePaths)) {
      validateManifestPath(errors, 'resourcePaths', relativePath, projectRoot);
    }
  }
  if (typeof manifest.adoptedExistingConfiguration !== 'boolean') {
    errors.push('Manifest adoptedExistingConfiguration must be a boolean.');
  }
  const verification = manifest.packageVerification;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    errors.push('Manifest packageVerification must be an object.');
  } else {
    if (!hasOnlyAllowedProperties(verification, PACKAGE_VERIFICATION_FIELDS)) {
      errors.push('Manifest packageVerification contains unsupported properties.');
    }
    if (!['verified', 'unverified'].includes(verification.status)) {
      errors.push('Manifest packageVerification.status must be "verified" or "unverified".');
    }
    if (![
      'known-capability',
      'package-documentation',
      'official-documentation',
      'user-approved',
    ].includes(verification.source)) {
      errors.push('Manifest packageVerification.source is invalid.');
    }
    if (verification.evidenceUrl !== undefined) {
      try {
        if (new URL(verification.evidenceUrl).protocol !== 'https:') {
          errors.push('Manifest packageVerification.evidenceUrl must be an HTTPS URL.');
        }
      } catch {
        errors.push('Manifest packageVerification.evidenceUrl must be an HTTPS URL.');
      }
    }
    if (manifest.packageName !== 'astro-built-in' &&
        (verification.license === undefined ||
         verification.licenseReview === undefined ||
         verification.artifact === undefined)) {
      errors.push(
        'npm-backed packages require packageVerification license, licenseReview, and artifact provenance.'
      );
    }
    if (verification.artifact !== undefined) {
      const artifact = verification.artifact;
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
        errors.push('Manifest packageVerification.artifact must be an object.');
      } else {
        if (!hasOnlyAllowedProperties(artifact, PACKAGE_ARTIFACT_FIELDS)) {
          errors.push(
            'Manifest packageVerification.artifact contains unsupported properties.'
          );
        }
        if (!isSafeBoundedText(artifact.version, 100) ||
            !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
              artifact.version || ''
            )) {
          errors.push(
            'Manifest packageVerification.artifact.version must be an exact semantic version.'
          );
        }
        if (artifact.registry !== 'https://registry.npmjs.org/') {
          errors.push(
            'Manifest packageVerification.artifact.registry must be the official npm registry.'
          );
        }
        let tarballUrl;
        try {
          tarballUrl = new URL(artifact.tarballUrl);
        } catch {
          tarballUrl = null;
        }
        if (!tarballUrl || tarballUrl.protocol !== 'https:' ||
            tarballUrl.hostname !== 'registry.npmjs.org' ||
            tarballUrl.username || tarballUrl.password) {
          errors.push(
            'Manifest packageVerification.artifact.tarballUrl must use the official npm registry.'
          );
        }
        if (!isSafeBoundedText(artifact.integrity, 500) ||
            !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(
              artifact.integrity || ''
            )) {
          errors.push(
            'Manifest packageVerification.artifact.integrity must be a supported SRI value.'
          );
        }
      }
    }
    if (verification.licenseReview !== undefined) {
      const licenseReview = verification.licenseReview;
      if (!licenseReview || typeof licenseReview !== 'object' ||
          Array.isArray(licenseReview)) {
        errors.push('Manifest packageVerification.licenseReview must be an object.');
      } else {
        if (!hasOnlyAllowedProperties(licenseReview, new Set(['status']))) {
          errors.push(
            'Manifest packageVerification.licenseReview contains unsupported properties.'
          );
        }
        if (!isSafeBoundedText(verification.license, 200)) {
          errors.push(
            'Manifest packageVerification.license must be a non-empty string of at most ' +
            '200 characters without control characters.'
          );
        }
        if (!['automatically-accepted', 'user-confirmed'].includes(
          licenseReview.status
        )) {
          errors.push(
            'Manifest packageVerification.licenseReview.status must be ' +
            '"automatically-accepted" or "user-confirmed".'
          );
        }
        if (licenseReview.status === 'automatically-accepted' &&
            !AUTOMATICALLY_ACCEPTED_LICENSES.has(verification.license)) {
          errors.push(
            'Automatically accepted package licenses must use the documented license list.'
          );
        }
      }
    }
    if (verification.status === 'unverified' && verification.source !== 'user-approved') {
      errors.push(
        'Unverified packages must use packageVerification.source "user-approved".'
      );
    }
    const knownPackage = KNOWN_PACKAGES[manifest.packageName];
    if (knownPackage && verification.status !== 'verified') {
      errors.push(
        `Known package "${manifest.packageName}" must use ` +
        'packageVerification.status "verified".'
      );
    }
    if (knownPackage && verification.source !== 'known-capability') {
      errors.push(
        `Known package "${manifest.packageName}" must use ` +
        'packageVerification.source "known-capability".'
      );
    }
    if (!knownPackage && verification.status === 'verified' &&
        !['package-documentation', 'official-documentation'].includes(
          verification.source
        )) {
      errors.push(
        'Verified alternative packages must cite package or official documentation.'
      );
    }
    if (verification.source === 'official-documentation' &&
        !verification.evidenceUrl) {
      errors.push('Official-documentation package verification requires evidenceUrl.');
    }
    if (verification.source === 'official-documentation' &&
        verification.status === 'verified') {
      if (verification.requestedMode !== manifest.mode) {
        errors.push(
          'Official-documentation package verification requestedMode must match manifest mode.'
        );
      }
      if (verification.classification !== 'supported') {
        errors.push(
          'Verified official-documentation package verification classification must be "supported".'
        );
      }
      if (typeof verification.explanation !== 'string' ||
          !verification.explanation.trim() ||
          verification.explanation.length > 2000) {
        errors.push(
          'Official-documentation package verification explanation must be a non-empty string of at most 2000 characters.'
        );
      }
      if (!Array.isArray(verification.evidence) ||
          verification.evidence.length === 0 ||
          verification.evidence.length > MAX_MODE_EVIDENCE_ENTRIES ||
          verification.evidence.some((entry) =>
            !entry || typeof entry !== 'object' || Array.isArray(entry) ||
            !hasOnlyAllowedProperties(entry, MODE_EVIDENCE_FIELDS) ||
            typeof entry.quote !== 'string' || !entry.quote.trim() ||
            entry.quote.length > 2000 ||
            typeof entry.explanation !== 'string' || !entry.explanation.trim() ||
            entry.explanation.length > 2000
          )) {
        errors.push(
          `Official-documentation package verification evidence must contain 1-${MAX_MODE_EVIDENCE_ENTRIES} ` +
          'quote/explanation entries of at most 2000 characters.'
        );
      }
      if (!Array.isArray(verification.supportConditions) ||
          verification.supportConditions.length > 20 ||
          verification.supportConditions.some((condition) =>
            typeof condition !== 'string' ||
            !condition.trim() ||
            condition.length > 500
          )) {
        errors.push(
          'Official-documentation package verification supportConditions must contain at most 20 non-empty strings of at most 500 characters.'
        );
      }
    }
  }
  if (manifest.initializationEvidence !== undefined) {
    const evidence = manifest.initializationEvidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      errors.push('Manifest initializationEvidence must be an object.');
    } else {
      if (typeof evidence.file !== 'string' || !evidence.file.trim()) {
        errors.push('Manifest initializationEvidence.file must be a non-empty path.');
      } else {
        validateManifestPath(errors, 'initializationEvidence.file', evidence.file, projectRoot);
      }
      if (typeof evidence.marker !== 'string' || !evidence.marker.trim()) {
        errors.push('Manifest initializationEvidence.marker must be a non-empty string.');
      } else if (evidence.marker.length > 200) {
        errors.push('Manifest initializationEvidence.marker must not exceed 200 characters.');
      }
    }
  }
  return errors;
}

function verifyInitializationEvidence(projectRoot, packageName, evidence) {
  if (!evidence) return { provided: false, valid: false };
  if (!packageName || typeof evidence.file !== 'string' ||
      typeof evidence.marker !== 'string') {
    return {
      provided: true,
      valid: false,
      reason: 'initialization evidence is missing its package, file, or marker',
    };
  }
  const resolvedEvidence = resolveProjectRelativePath(projectRoot, evidence.file);
  if (!resolvedEvidence.valid) {
    return {
      provided: true,
      valid: false,
      reason: `initialization evidence file ${resolvedEvidence.reason}`,
    };
  }
  const evidencePath = resolvedEvidence.path;
  if (!fs.existsSync(evidencePath) || !fs.statSync(evidencePath).isFile()) {
    return {
      provided: true,
      valid: false,
      reason: `initialization evidence file does not exist: ${evidence.file}`,
    };
  }
  if (fs.statSync(evidencePath).size > DEFAULT_SOURCE_SCAN_LIMITS.maxFileBytes) {
    return {
      provided: true,
      valid: false,
      reason: 'initialization evidence file exceeds the 1 MiB source-file limit',
    };
  }

  const text = fs.readFileSync(evidencePath, 'utf8');
  const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Accept normal ESM imports, side-effect imports, require(), and package subpaths.
  const packageImport = new RegExp(
    `(?:from\\s*['"]${escapedPackage}(?:\\/[^'"]*)?['"]|` +
    `import\\s*['"]${escapedPackage}(?:\\/[^'"]*)?['"]|` +
    `require\\(\\s*['"]${escapedPackage}(?:\\/[^'"]*)?['"]\\s*\\))`
  );
  if (!packageImport.test(text)) {
    return {
      provided: true,
      valid: false,
      file: evidence.file,
      reason: `initialization evidence file does not import "${packageName}"`,
    };
  }
  if (!text.includes(evidence.marker)) {
    return {
      provided: true,
      valid: false,
      file: evidence.file,
      reason: `initialization marker was not found in ${evidence.file}`,
    };
  }
  return {
    provided: true,
    valid: true,
    file: evidence.file,
    marker: evidence.marker,
  };
}

function loadRegistry(registryPath = REGISTRY_PATH) {
  if (registryPath === REGISTRY_PATH && cachedRegistry) return cachedRegistry;
  const registry = readJson(registryPath);
  if (!registry || !registry.types) {
    throw new Error(`BCP-47 registry snapshot is missing or invalid: ${registryPath}`);
  }
  const normalized = {
    ...registry,
    sets: Object.fromEntries(
      Object.entries(registry.types).map(([type, values]) => [
        type,
        new Set(values.map((value) => value.toLowerCase())),
      ])
    ),
  };
  if (registryPath === REGISTRY_PATH) cachedRegistry = normalized;
  return normalized;
}

function validateCanonicalTag(canonicalTag, registry) {
  const lowerTag = canonicalTag.toLowerCase();
  if (registry.sets.grandfathered?.has(lowerTag) || registry.sets.redundant?.has(lowerTag)) {
    return [];
  }

  const locale = new Intl.Locale(canonicalTag);
  const errors = [];
  const language = locale.language.toLowerCase();
  if (!registry.sets.language?.has(language)) {
    errors.push(`unknown language subtag "${locale.language}"`);
  }
  if (locale.script && !registry.sets.script?.has(locale.script.toLowerCase())) {
    errors.push(`unknown script subtag "${locale.script}"`);
  }
  if (locale.region && !registry.sets.region?.has(locale.region.toLowerCase())) {
    errors.push(`unknown region subtag "${locale.region}"`);
  }

  // Intl.Locale.baseName normalizes away extensions/private-use and leaves the
  // registered language-script-region-variant sequence, e.g. sl-rozaj-biske.
  const baseParts = locale.baseName.split('-');
  let index = 1;
  if (locale.script && baseParts[index]?.toLowerCase() === locale.script.toLowerCase()) index += 1;
  if (locale.region && baseParts[index]?.toLowerCase() === locale.region.toLowerCase()) index += 1;
  for (; index < baseParts.length; index += 1) {
    const variant = baseParts[index].toLowerCase();
    if (!registry.sets.variant?.has(variant)) {
      errors.push(`unknown variant subtag "${baseParts[index]}"`);
    }
  }

  return errors;
}

function validateLocales(input, options = {}) {
  const registry = loadRegistry(options.registryPath);
  const rawValues = Array.isArray(input) ? input : String(input || '').split(',');
  const accepted = [];
  const invalid = [];
  const canonicalization = [];
  const duplicates = [];
  const seen = new Set();

  for (const rawValue of rawValues) {
    const original = String(rawValue).trim();
    if (!original) {
      invalid.push({ input: original, reason: 'empty language tag' });
      continue;
    }

    const lowerOriginal = original.toLowerCase();
    const fullTagType = registry.sets.grandfathered?.has(lowerOriginal)
      ? 'grandfathered'
      : registry.sets.redundant?.has(lowerOriginal)
        ? 'redundant'
        : null;
    let canonical;
    if (fullTagType) {
      const preferred = registry.preferredValues?.[fullTagType]?.[lowerOriginal];
      canonical = preferred || original;
      if (preferred) {
        try {
          [canonical] = Intl.getCanonicalLocales(preferred);
        } catch {
          canonical = preferred;
        }
      }
    } else if (/^x(?:-[a-z0-9]{1,8})+$/i.test(original)) {
      canonical = lowerOriginal;
    } else {
      try {
        [canonical] = Intl.getCanonicalLocales(original);
      } catch {
        invalid.push({ input: original, reason: 'malformed BCP-47 language tag' });
        continue;
      }
    }

    let registryErrors;
    if (fullTagType && !registry.preferredValues?.[fullTagType]?.[lowerOriginal]) {
      registryErrors = [];
    } else if (/^x-/i.test(canonical)) {
      registryErrors = [];
    } else {
      try {
        registryErrors = validateCanonicalTag(canonical, registry);
      } catch {
        invalid.push({ input: original, reason: 'unsupported BCP-47 language tag shape' });
        continue;
      }
    }
    if (registryErrors.length > 0) {
      invalid.push({ input: original, canonical, reason: registryErrors.join('; ') });
      continue;
    }

    const key = canonical.toLowerCase();
    if (seen.has(key)) {
      duplicates.push({ input: original, canonical });
      continue;
    }
    seen.add(key);
    accepted.push(canonical);
    if (canonical !== original) canonicalization.push({ input: original, canonical });
  }

  return {
    valid: invalid.length === 0,
    locales: accepted,
    canonicalization,
    duplicates,
    invalid,
    registryFileDate: registry.fileDate,
  };
}

function getLocaleDirection(locale) {
  let canonical;
  let parsed;
  try {
    [canonical] = Intl.getCanonicalLocales(locale);
    parsed = new Intl.Locale(canonical);
  } catch {
    // Private-use-only tags such as x-contoso are valid BCP-47 identifiers but
    // do not carry script metadata from which a direction can be derived.
    return 'ltr';
  }

  // Node exposes Unicode text direction through Intl.Locale.textInfo. Keep the
  // language fallback for older Node releases that do not implement it.
  const intlDirection = parsed.textInfo?.direction;
  if (intlDirection === 'rtl' || intlDirection === 'ltr') return intlDirection;

  const rtlLanguages = new Set(['ar', 'dv', 'fa', 'he', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi']);
  return rtlLanguages.has(parsed.language.toLowerCase()) ? 'rtl' : 'ltr';
}

function resolveLocale(input) {
  const validation = validateLocales([input]);
  if (!validation.valid || validation.locales.length !== 1) {
    return {
      ...validation,
      locale: null,
      direction: null,
    };
  }

  const [locale] = validation.locales;
  return {
    ...validation,
    locale,
    direction: getLocaleDirection(locale),
  };
}

function detectLocalization(projectRoot) {
  const manifestPath = path.join(projectRoot, MANIFEST_NAME);
  const manifestExists = fs.existsSync(manifestPath);
  const manifest = readJson(manifestPath);
  const dependencies = packageDependencies(projectRoot);
  const packages = Object.keys(KNOWN_PACKAGES).filter((name) => dependencies[name]);
  const resourceCandidates = [
    'src/i18n',
    'src/locales',
    'src/assets/i18n',
    'src/locale',
  ].filter((relativePath) => fs.existsSync(path.join(projectRoot, relativePath)));
  const angularConfig = readJson(path.join(projectRoot, 'angular.json'));
  const angularI18n = Boolean(angularConfig && JSON.stringify(angularConfig).includes('"i18n"'));
  const astroConfig = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts']
    .find((relativePath) => {
      const fullPath = path.join(projectRoot, relativePath);
      return fs.existsSync(fullPath) && fs.readFileSync(fullPath, 'utf8').includes('i18n');
    });

  const detected = Boolean(manifestExists || packages.length || resourceCandidates.length || angularI18n || astroConfig);
  const conflicts = [];
  if (manifestExists && !manifest) {
    conflicts.push(`${MANIFEST_NAME} exists but is not valid JSON`);
  }
  const manifestObject = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? manifest
    : null;
  if (manifest) conflicts.push(...validateLocalizationManifestShape(manifest, projectRoot));
  const manifestPackage = typeof manifestObject?.packageName === 'string'
    ? manifestObject.packageName
    : null;
  const initializationEvidence = manifestObject?.initializationEvidence;
  const manifestMode = typeof manifestObject?.mode === 'string' ? manifestObject.mode : null;
  const manifestLocales = Array.isArray(manifestObject?.locales) &&
    manifestObject.locales.every((locale) => typeof locale === 'string')
    ? manifestObject.locales
    : null;
  const manifestDefault = typeof manifestObject?.defaultLocale === 'string'
    ? manifestObject.defaultLocale
    : null;
  const manifestResources = manifestObject?.resourcePaths &&
    typeof manifestObject.resourcePaths === 'object' &&
    !Array.isArray(manifestObject.resourcePaths) &&
    Object.values(manifestObject.resourcePaths).every((value) => typeof value === 'string')
    ? manifestObject.resourcePaths
    : null;
  if (manifestPackage && !dependencies[manifestPackage] &&
      manifestPackage !== 'astro-built-in') {
    conflicts.push('manifest package is not installed');
  }
  if (manifestLocales) {
    const validation = validateLocales(manifestLocales);
    if (!validation.valid || validation.locales.length !== manifestLocales.length) {
      conflicts.push('manifest contains invalid or duplicate locales');
    }
    if (!manifestLocales.includes(manifestDefault)) {
      conflicts.push('manifest defaultLocale is not present in locales');
    }
  }
  if (packages.length > 1) {
    const modes = new Set(packages.map((name) => KNOWN_PACKAGES[name].mode));
    if (modes.size > 1) conflicts.push('runtime and static localization packages are both installed');
  }

  const inferredMode = manifestMode || inferMode(packages, angularI18n, astroConfig);
  const inferredPackage = manifestPackage || inferPrimaryPackage(packages, astroConfig);
  const inferredResources = manifestResources ||
    discoverLocaleResources(projectRoot, resourceCandidates);
  let inferredLocales = manifestLocales || Object.keys(inferredResources);
  const inferredDefault = manifestDefault ||
    inferDefaultLocale(projectRoot, angularConfig, astroConfig, inferredLocales);
  if (!manifest && inferredDefault && !inferredResources[inferredDefault]) {
    const angularSource = path.join(projectRoot, 'src', 'locale', 'messages.xlf');
    if (fs.existsSync(angularSource)) {
      inferredResources[inferredDefault] = 'src/locale/messages.xlf';
      inferredLocales = Object.keys(inferredResources);
    }
  }

  if (detected && !inferredMode) conflicts.push('localization mode could not be determined');
  if (detected && inferredLocales.length === 0) conflicts.push('no locale resources could be determined');
  if (detected && !inferredDefault) conflicts.push('default locale could not be determined');
  if (inferredLocales.length > 0) {
    const validation = validateLocales(inferredLocales);
    if (!validation.valid || validation.duplicates.length) {
      conflicts.push('detected locale resource names are invalid or duplicated');
    }
  }
  if (inferredDefault && !inferredLocales.includes(inferredDefault)) {
    conflicts.push('detected default locale is not present in locale resources');
  }
  const frameworkDetection = detectFramework(projectRoot);
  if (frameworkDetection.framework) {
    const mismatchedPackages = packages.filter((packageName) =>
      KNOWN_PACKAGES[packageName]?.framework !== frameworkDetection.framework
    );
    if (mismatchedPackages.length) {
      conflicts.push(
        `localization package(s) do not match detected ${frameworkDetection.framework} framework: ` +
        mismatchedPackages.join(', ')
      );
    }
  }
  const packageFrameworks = new Set(
    packages.map((packageName) => KNOWN_PACKAGES[packageName]?.framework).filter(Boolean)
  );
  if (packageFrameworks.size > 1) {
    conflicts.push('localization packages for multiple frameworks are installed');
  }

  const implementationFramework = frameworkDetection.framework ||
    (frameworkDetection.ambiguous &&
      frameworkDetection.candidates.includes(manifestObject?.framework)
      ? manifestObject.framework
      : null);
  const implementation = discoverLocalizationImplementation(
    projectRoot,
    implementationFramework,
    inferredMode,
    angularI18n,
    astroConfig,
    {
      packageName: inferredPackage,
      initializationEvidence,
    }
  );
  if (implementation.initializationEvidence.provided &&
      !implementation.initializationEvidence.valid) {
    conflicts.push(implementation.initializationEvidence.reason);
  }
  if (detected && !implementation.initialization) {
    conflicts.push('localization initialization could not be determined');
  }
  if (detected && !implementation.selector) {
    conflicts.push('language selector or locale navigation could not be determined');
  }
  if (detected && !implementation.lang) {
    conflicts.push('document language (lang) handling could not be determined');
  }
  if (detected && !implementation.dir) {
    conflicts.push('document direction (dir) handling could not be determined');
  }
  if (detected && implementation.scan.limitReached) {
    conflicts.push(
      `localization source scan reached its ${implementation.scan.maxTotalBytes}-byte limit`
    );
  }
  if (detected && implementation.scan.skippedFiles.length &&
      !Object.values({
        initialization: implementation.initialization,
        selector: implementation.selector,
        lang: implementation.lang,
        dir: implementation.dir,
      }).every(Boolean)) {
    conflicts.push(
      `localization source scan skipped ${implementation.scan.skippedFiles.length} oversized file(s)`
    );
  }

  return {
    detected,
    valid: detected && conflicts.length === 0,
    manifestPath: manifestExists ? manifestPath : null,
    manifest,
    packages,
    packageName: inferredPackage,
    mode: inferredMode,
    locales: inferredLocales,
    defaultLocale: inferredDefault,
    resourcePaths: inferredResources,
    resourceDirectories: resourceCandidates,
    angularI18n,
    astroConfig: astroConfig || null,
    implementation,
    conflicts,
  };
}

function inferMode(packages, angularI18n, astroConfig) {
  const modes = new Set(packages.map((name) => KNOWN_PACKAGES[name]?.mode).filter(Boolean));
  if (angularI18n || astroConfig) modes.add('static');
  return modes.size === 1 ? [...modes][0] : null;
}

function inferPrimaryPackage(packages, astroConfig) {
  for (const capability of Object.values(LOCALIZATION_CAPABILITIES.frameworks)) {
    for (const packageName of Object.values(capability.recommendedPackages)) {
      if (packageName === 'astro-built-in') {
        if (astroConfig) return packageName;
      } else if (packages.includes(packageName)) {
        return packageName;
      }
    }
  }
  return null;
}

function discoverLocaleResources(projectRoot, resourceCandidates) {
  const resources = {};
  for (const relativeDirectory of resourceCandidates) {
    const fullDirectory = path.join(projectRoot, relativeDirectory);
    for (const filePath of walkFiles(fullDirectory)) {
      if (!/\.(?:json|xlf\d?)$/i.test(filePath)) continue;
      const fileName = path.basename(filePath).replace(/\.(?:json|xlf\d?)$/i, '');
      const fileCandidate = fileName.replace(/^messages\./i, '');
      let validation = validateLocales([fileCandidate]);
      if (!validation.valid) {
        validation = validateLocales([path.basename(path.dirname(filePath))]);
      }
      if (validation.valid && validation.locales.length === 1) {
        resources[validation.locales[0]] = path.relative(projectRoot, filePath).replace(/\\/g, '/');
      }
    }
  }
  return resources;
}

function* walkFiles(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(fullPath);
    else if (entry.isFile()) yield fullPath;
  }
}

function inferDefaultLocale(projectRoot, angularConfig, astroConfig, locales) {
  const angularSource = angularConfig && findNestedValue(angularConfig, 'sourceLocale');
  if (typeof angularSource === 'string') {
    const validation = validateLocales([angularSource]);
    if (validation.valid) return validation.locales[0];
  }

  if (astroConfig) {
    const content = fs.readFileSync(path.join(projectRoot, astroConfig), 'utf8');
    const match = content.match(/defaultLocale\s*:\s*['"]([^'"]+)['"]/);
    if (match) {
      const validation = validateLocales([match[1]]);
      if (validation.valid) return validation.locales[0];
    }
  }

  for (const relativePath of [
    'src/i18n/index.ts',
    'src/i18n/index.js',
    'src/main.ts',
    'src/main.js',
    'src/app/app.config.ts',
  ]) {
    const fullPath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    const match = content.match(
      /(?:fallbackLng|fallbackLocale|defaultLocale|defaultLanguage)\s*:\s*['"]([^'"]+)['"]/
    );
    if (match) {
      const validation = validateLocales([match[1]]);
      if (validation.valid) return validation.locales[0];
    }
  }

  return locales.length === 1 ? locales[0] : null;
}

function findNestedValue(value, key) {
  if (!value || typeof value !== 'object') return null;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findNestedValue(child, key);
    if (found !== null) return found;
  }
  return null;
}

function discoverLocalizationImplementation(
  projectRoot,
  framework,
  mode,
  angularI18n,
  astroConfig,
  options = {}
) {
  const sourceRoot = path.join(projectRoot, 'src');
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_SOURCE_SCAN_LIMITS.maxFileBytes;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_SOURCE_SCAN_LIMITS.maxTotalBytes;
  const initializationEvidence = verifyInitializationEvidence(
    projectRoot,
    options.packageName,
    options.initializationEvidence
  );
  const initializationPatterns = {
    react: /i18next\.init|initReactI18next|I18nextProvider/i,
    vue: /createI18n\s*\(/i,
    angular: mode === 'static'
      ? /\bi18n(?:-|=)|\$localize/i
      : /provideTransloco|TranslocoModule|transloco/i,
    astro: /getRelativeLocaleUrl|getAbsoluteLocaleUrl|Astro\.currentLocale|i18n/i,
  };
  const configurationInitialization = framework === 'angular' && mode === 'static'
    ? Boolean(angularI18n)
    : framework === 'astro'
      ? Boolean(astroConfig)
      : false;
  const signals = {
    initialization: initializationEvidence.valid || configurationInitialization,
    selector: false,
    lang: false,
    dir: false,
  };
  const files = [];
  const skippedFiles = [];
  let bytesRead = 0;
  let limitReached = false;

  for (const filePath of walkFiles(sourceRoot)) {
    if (!/\.(?:js|jsx|ts|tsx|vue|astro|html)$/i.test(filePath)) continue;
    const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    const fileBytes = fs.statSync(filePath).size;
    if (fileBytes > maxFileBytes) {
      skippedFiles.push({ path: relativePath, bytes: fileBytes, reason: 'file-size-limit' });
      continue;
    }
    if (bytesRead + fileBytes > maxTotalBytes) {
      limitReached = true;
      break;
    }

    const text = fs.readFileSync(filePath, 'utf8');
    bytesRead += fileBytes;
    files.push(relativePath);
    signals.initialization ||= Boolean(initializationPatterns[framework]?.test(text));
    signals.selector ||= hasLocaleNavigationSignal(text);
    signals.lang ||= /\bhtmlLang\b|documentElement\.lang|setAttribute\(['"]lang|<html\b[^>]*\blang=/i.test(text);
    signals.dir ||= /\bhtmlDir\b|documentElement\.dir|setAttribute\(['"]dir|<html\b[^>]*\bdir=/i.test(text);
    if (Object.values(signals).every(Boolean)) break;
  }

  return {
    files,
    ...signals,
    initializationEvidence,
    scan: {
      bytesRead,
      maxFileBytes,
      maxTotalBytes,
      skippedFiles,
      limitReached,
      stoppedEarly: Object.values(signals).every(Boolean),
    },
  };
}

function detectSiteLanguage(projectRoot, framework) {
  const candidates = [
    path.join(projectRoot, 'index.html'),
    path.join(projectRoot, 'src', 'index.html'),
  ];
  const astroLayouts = path.join(projectRoot, 'src', 'layouts');
  if (framework === 'astro' && fs.existsSync(astroLayouts)) {
    for (const filePath of walkFiles(astroLayouts)) {
      if (/\.astro$/i.test(filePath)) candidates.push(filePath);
    }
  }

  const findings = [];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    const htmlTag = text.match(/<html\b[^>]*>/i)?.[0];
    if (!htmlTag) continue;
    const lang = htmlTag.match(/\blang\s*=\s*(["'])([^"']+)\1/i)?.[2];
    if (!lang || /[{}]/.test(lang)) continue;
    const direction = htmlTag.match(/\bdir\s*=\s*(["'])([^"']+)\1/i)?.[2]?.toLowerCase() || null;
    findings.push({
      source: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
      lang,
      direction,
    });
  }

  if (findings.length === 0) {
    return {
      detected: false,
      valid: false,
      locale: null,
      direction: null,
      source: null,
      conflicts: [],
    };
  }

  const conflicts = [];
  const resolved = findings.map((finding) => ({
    ...finding,
    resolved: resolveLocale(finding.lang),
  }));
  for (const finding of resolved) {
    if (!finding.resolved.valid) {
      conflicts.push(
        `${finding.source} has an invalid document language "${finding.lang}".`
      );
      continue;
    }
    if (!['ltr', 'rtl'].includes(finding.direction)) {
      conflicts.push(`${finding.source} is missing a valid html dir attribute.`);
      continue;
    }
    if (finding.direction !== finding.resolved.direction) {
      conflicts.push(
        `${finding.source} uses dir="${finding.direction}" but ` +
        `${finding.resolved.locale} resolves to "${finding.resolved.direction}".`
      );
    }
  }

  const distinctLocales = [...new Set(
    resolved
      .filter((finding) => finding.resolved.valid)
      .map((finding) => finding.resolved.locale)
  )];
  if (distinctLocales.length > 1) {
    conflicts.push(
      `Conflicting document languages were found: ${distinctLocales.join(', ')}.`
    );
  }

  const primary = resolved.find((finding) => finding.resolved.valid) || resolved[0];
  return {
    detected: true,
    valid: conflicts.length === 0,
    locale: primary.resolved.locale,
    direction: primary.direction,
    source: primary.source,
    conflicts,
  };
}

function inspectProject(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  const framework = detectFramework(resolvedRoot);
  const siteLanguage = detectSiteLanguage(resolvedRoot, framework.framework);
  const localization = detectLocalization(resolvedRoot);
  const safeSiteLanguage = {
    detected: siteLanguage.detected,
    valid: siteLanguage.valid,
    locale: siteLanguage.locale
      ? sanitizeUntrustedText(siteLanguage.locale, 100)
      : null,
    direction: siteLanguage.direction
      ? sanitizeUntrustedText(siteLanguage.direction, 20)
      : null,
    source: siteLanguage.source
      ? sanitizeUntrustedText(siteLanguage.source, 500)
      : null,
    conflicts: siteLanguage.conflicts.map(
      (value) => sanitizeUntrustedText(value, 500)
    ),
  };
  const safeLocalization = {
    detected: localization.detected,
    valid: localization.valid,
    manifestPresent: Boolean(localization.manifestPath),
    packages: localization.packages.map((value) => sanitizeUntrustedText(value, 214)),
    packageName: localization.packageName
      ? sanitizeUntrustedText(localization.packageName, 214)
      : null,
    mode: localization.mode ? sanitizeUntrustedText(localization.mode, 20) : null,
    locales: localization.locales.map((value) => sanitizeUntrustedText(value, 100)),
    defaultLocale: localization.defaultLocale
      ? sanitizeUntrustedText(localization.defaultLocale, 100)
      : null,
    resourcePaths: Object.fromEntries(
      Object.entries(localization.resourcePaths).map(([locale, relativePath]) => [
        sanitizeUntrustedText(locale, 100),
        sanitizeUntrustedText(relativePath, 500),
      ])
    ),
    resourceDirectories: localization.resourceDirectories.map(
      (value) => sanitizeUntrustedText(value, 500)
    ),
    angularI18n: localization.angularI18n,
    astroConfig: localization.astroConfig
      ? sanitizeUntrustedText(localization.astroConfig, 500)
      : null,
    implementation: {
      initialization: localization.implementation.initialization,
      selector: localization.implementation.selector,
      lang: localization.implementation.lang,
      dir: localization.implementation.dir,
      files: localization.implementation.files.map(
        (value) => sanitizeUntrustedText(value, 500)
      ),
      initializationEvidence: {
        provided: localization.implementation.initializationEvidence.provided,
        valid: localization.implementation.initializationEvidence.valid,
        reason: localization.implementation.initializationEvidence.reason
          ? sanitizeUntrustedText(
            localization.implementation.initializationEvidence.reason,
            500
          )
          : null,
      },
      scan: {
        bytesRead: localization.implementation.scan.bytesRead,
        maxFileBytes: localization.implementation.scan.maxFileBytes,
        maxTotalBytes: localization.implementation.scan.maxTotalBytes,
        skippedFiles: localization.implementation.scan.skippedFiles.map(
          (value) => sanitizeUntrustedText(value, 500)
        ),
        limitReached: localization.implementation.scan.limitReached,
        stoppedEarly: localization.implementation.scan.stoppedEarly,
      },
    },
    conflicts: localization.conflicts.map(
      (value) => sanitizeUntrustedText(value, 500)
    ),
    untrustedProjectData: true,
  };
  return {
    projectRoot: sanitizeUntrustedText(resolvedRoot, 1000),
    framework,
    siteLanguage: safeSiteLanguage,
    localization: safeLocalization,
  };
}

function protectedTokenSignature(value) {
  const text = String(value ?? '');
  const icu = extractIcuData(text);
  const literals = extractIcuQuotedLiterals(text);
  const externalLiteralSignatures = literals.signature.filter((unused, index) => {
    const [literalStart, literalEnd] = literals.spans[index];
    return !icu.spans.some(
      ([icuStart, icuEnd]) => literalStart >= icuStart && literalEnd <= icuEnd
    );
  });
  // ICU parser offsets are UTF-16 string indexes, so preserve code units here.
  // A code-point array (`[...text]`) would shift masks after emoji or other surrogate pairs.
  const nonIcuText = text.split('');
  for (const [start, end] of [...icu.spans, ...literals.spans]) {
    nonIcuText.fill(' ', start, end);
  }
  // One alternation prevents the single-brace pattern from also matching the
  // inner portion of a double-brace token such as `{{name}}`.
  const tokenPattern =
    /\{\{[^{}]+\}\}|\{[A-Za-z_][A-Za-z0-9_.-]*\}|%(?:\d+\$)?[sdif]|<\/?[A-Za-z][^>]*>|https?:\/\/[^\s)"']+/g;
  const tokens = nonIcuText.join('').match(tokenPattern) || [];
  tokens.push(...icu.signature, ...externalLiteralSignatures);
  return tokens.sort();
}

function extractIcuQuotedLiterals(text) {
  const signature = [];
  const spans = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "'" || !/[{}#]/.test(text[start + 1] || '')) continue;
    let end = start + 2;
    for (; end < text.length; end += 1) {
      if (text[end] !== "'") continue;
      if (text[end + 1] === "'") {
        end += 1;
        continue;
      }
      break;
    }
    if (end >= text.length) continue;
    const literal = text.slice(start + 1, end).replace(/''/g, "'");
    signature.push(`ICU_LITERAL:${literal}`);
    spans.push([start, end + 1]);
    start = end;
  }
  return { signature, spans };
}

function findBalancedBraceEnd(text, start) {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "'") {
      if (text[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (quoted) {
        quoted = false;
        continue;
      }
      if (/[{}#]/.test(text[index + 1] || '')) {
        quoted = true;
        continue;
      }
    }
    if (quoted) continue;
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function countUnquotedPounds(text) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "'") {
      if (text[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (quoted) {
        quoted = false;
        continue;
      }
      if (/[{}#]/.test(text[index + 1] || '')) {
        quoted = true;
        continue;
      }
    }
    if (!quoted && text[index] === '#') count += 1;
  }
  return count;
}

function extractIcuData(text) {
  const signature = [];
  const spans = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    const end = findBalancedBraceEnd(text, start);
    if (end < 0) break;
    const expression = text.slice(start + 1, end);
    const header = expression.match(
      /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*,\s*(plural|selectordinal|select|number|date|time)\s*(?:,\s*)?/i
    );
    if (!header) continue;
    const argument = header[1];
    const type = header[2].toLowerCase();
    const body = expression.slice(header[0].length);
    signature.push(`ICU:${argument}:${type}`);
    spans.push([start, end + 1]);
    if (['plural', 'selectordinal', 'select'].includes(type)) {
      let cursor = 0;
      while (cursor < body.length) {
        const whitespace = body.slice(cursor).match(/^\s+/);
        if (whitespace) cursor += whitespace[0].length;
        const offset = body.slice(cursor).match(/^offset\s*:\s*(\d+)/i);
        if (offset) {
          signature.push(`ICU:${argument}:offset:${offset[1]}`);
          cursor += offset[0].length;
          continue;
        }
        const selector = body.slice(cursor).match(/^(=?\d+|[A-Za-z][\w-]*)\s*/);
        if (!selector) {
          cursor += 1;
          continue;
        }
        cursor += selector[0].length;
        if (body[cursor] !== '{') continue;
        const branchEnd = findBalancedBraceEnd(body, cursor);
        if (branchEnd < 0) break;
        signature.push(`ICU:${argument}:${selector[1]}`);
        const branch = body.slice(cursor + 1, branchEnd);
        if (type !== 'select') {
          signature.push(...Array(countUnquotedPounds(branch)).fill(`ICU:${argument}:#`));
        }
        signature.push(...protectedTokenSignature(branch));
        cursor = branchEnd + 1;
      }
    } else if (body.trim()) {
      signature.push(`ICU:${argument}:style:${body.trim()}`);
    }
    start = end;
  }
  return { signature, spans };
}

function extractIcuSignature(text) {
  return extractIcuData(String(text ?? '')).signature;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = rest[index + 1];
    index += 1;
  }
  return args;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'inspect' && args.projectRoot) {
    process.stdout.write(`${JSON.stringify(inspectProject(args.projectRoot), null, 2)}\n`);
    return;
  }
  if (args.command === 'validate-locales' && args.locales !== undefined) {
    const result = validateLocales(args.locales);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.valid ? 0 : 1;
    return;
  }
  if (args.command === 'resolve-locale' && args.locale !== undefined) {
    const result = resolveLocale(args.locale);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.valid ? 0 : 1;
    return;
  }
  process.stderr.write(
    'Usage: localization-config.js inspect --projectRoot <path> | ' +
    'validate-locales --locales <comma-separated-tags> | ' +
    'resolve-locale --locale <language-tag>\n'
  );
  process.exitCode = 1;
}

if (require.main === module) runCli();

module.exports = {
  DEFAULT_SOURCE_SCAN_LIMITS,
  LOCALIZATION_CAPABILITIES,
  MANIFEST_NAME,
  MAX_MODE_EVIDENCE_ENTRIES,
  KNOWN_PACKAGES,
  hasLocaleNavigationSignal,
  detectFramework,
  detectLocalization,
  detectSiteLanguage,
  getLocaleDirection,
  inspectProject,
  loadRegistry,
  resolveProjectRelativePath,
  resolveLocale,
  validateLocalizationManifestShape,
  validateLocales,
  verifyInitializationEvidence,
  protectedTokenSignature,
  extractIcuSignature,
  discoverLocalizationImplementation,
};
