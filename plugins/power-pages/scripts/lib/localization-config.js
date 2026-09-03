#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST_NAME = '.powerpages-localization.json';
const REGISTRY_PATH = path.join(__dirname, '..', '..', 'references', 'bcp47-subtags.json');

function defineFrameworkCapability({
  modes,
  recommendedMode,
  recommendedPackages,
  frameworkPeers,
}) {
  const frozenModes = Object.freeze(Object.fromEntries(
    Object.entries(modes).map(([mode, availability]) => [
      mode,
      Object.freeze({ ...availability }),
    ])
  ));
  const supportedModes = Object.freeze(Object.keys(frozenModes));
  const availableModes = Object.freeze(supportedModes.filter(
    (mode) => frozenModes[mode].status === 'available'
  ));
  return Object.freeze({
    modes: frozenModes,
    supportedModes,
    availableModes,
    recommendedMode,
    recommendedPackages: Object.freeze(recommendedPackages),
    frameworkPeers: Object.freeze(frameworkPeers),
  });
}

const LOCALIZATION_CAPABILITIES = Object.freeze({
  frameworks: Object.freeze({
    react: defineFrameworkCapability({
      modes: {
        runtime: { status: 'available' },
      },
      recommendedMode: 'runtime',
      recommendedPackages: { runtime: 'react-i18next' },
      frameworkPeers: ['react', 'react-dom'],
    }),
    vue: defineFrameworkCapability({
      modes: {
        runtime: { status: 'available' },
      },
      recommendedMode: 'runtime',
      recommendedPackages: { runtime: 'vue-i18n' },
      frameworkPeers: ['vue'],
    }),
    angular: defineFrameworkCapability({
      modes: {
        runtime: { status: 'available' },
        static: {
          status: 'temporarily-unavailable',
          reasonCode: 'angular-static-temporarily-unavailable',
          reason:
            'Angular static localization is temporarily unavailable in this release. ' +
            'Angular runtime localization is available; @jsverse/transloco is recommended, ' +
            'and compatible validated runtime alternatives are allowed.',
        },
      },
      recommendedMode: 'runtime',
      recommendedPackages: {
        runtime: '@jsverse/transloco',
        static: '@angular/localize',
      },
      frameworkPeers: [
        '@angular/core',
        '@angular/compiler',
        '@angular/compiler-cli',
      ],
    }),
    astro: defineFrameworkCapability({
      modes: {
        static: {
          status: 'temporarily-unavailable',
          reasonCode: 'astro-static-temporarily-unavailable',
          reason:
            'Astro static localization is temporarily unavailable in this release. ' +
            'No Astro localization mode is currently available.',
        },
      },
      recommendedMode: null,
      recommendedPackages: { static: 'astro-built-in' },
      frameworkPeers: ['astro'],
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

function getLocalizationModeAvailability(framework, mode) {
  const capability = LOCALIZATION_CAPABILITIES.frameworks[framework];
  if (!capability) {
    return {
      framework,
      mode,
      supported: false,
      available: false,
      status: 'unsupported',
      recommendedPackage: null,
      builtIn: false,
      reasonCode: 'unsupported-framework',
      reason: `Framework "${framework}" is not supported by add-localization.`,
    };
  }
  const availability = capability.modes[mode];
  if (!availability) {
    return {
      framework,
      mode,
      supported: false,
      available: false,
      status: 'unsupported',
      recommendedPackage: null,
      builtIn: false,
      reasonCode: 'unsupported-mode',
      reason: `${framework} does not support "${mode}" mode in add-localization.`,
    };
  }
  const recommendedPackage = capability.recommendedPackages[mode] || null;
  return {
    framework,
    mode,
    supported: true,
    available: availability.status === 'available',
    recommendedPackage,
    builtIn: Boolean(KNOWN_PACKAGES[recommendedPackage]?.builtIn),
    ...availability,
  };
}

function getFrameworkLocalizationAvailability(framework) {
  const capability = LOCALIZATION_CAPABILITIES.frameworks[framework];
  if (!capability) {
    return {
      framework,
      supported: false,
      availableModes: [],
      recommendedMode: null,
      modes: {},
    };
  }
  return {
    framework,
    supported: true,
    availableModes: [...capability.availableModes],
    recommendedMode: capability.recommendedMode,
    modes: Object.fromEntries(capability.supportedModes.map((mode) => [
      mode,
      getLocalizationModeAvailability(framework, mode),
    ])),
  };
}
const DEFAULT_SOURCE_SCAN_LIMITS = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
});
// Direction belongs to a writing script, not permanently to a language. The
// runtime's ICU/CLDR data supplies likely scripts through Intl.Locale#maximize.
// CLDR ScriptMetadata field 6 identifies every script containing RTL letters;
// keep this list complete because Intl.Locale#textInfo can report language-level
// direction even when an explicit script requests the opposite direction.
// See: https://github.com/unicode-org/cldr/blob/main/common/properties/scriptMetadata.txt
const RTL_SCRIPTS = Object.freeze(new Set([
  'Adlm', 'Arab', 'Aran', 'Armi', 'Avst', 'Chrs', 'Cprt', 'Elym', 'Gara',
  'Hatr', 'Hebr', 'Hung', 'Khar', 'Lydi', 'Mand', 'Mani', 'Mend', 'Merc',
  'Mero', 'Narb', 'Nbat', 'Nkoo', 'Orkh', 'Ougr', 'Palm', 'Phli', 'Phlp',
  'Phnx', 'Prti', 'Rohg', 'Samr', 'Sarb', 'Sidt', 'Sogd', 'Sogo', 'Syrc',
  'Syre', 'Syrj', 'Syrn', 'Thaa', 'Yezi',
]));

let cachedRegistry;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function validateLocalizationManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['Localization manifest must be a JSON object.'];
  }
  const errors = [];
  if (typeof manifest.schemaVersion !== 'number') {
    errors.push('Manifest schemaVersion must be a number.');
  }
  for (const field of [
    'framework',
    'mode',
    'packageName',
    'packageVersion',
    'defaultLocale',
    'translationMethod',
    'lastOperation',
    'updatedAt',
  ]) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      errors.push(`Manifest ${field} must be a non-empty string.`);
    }
  }
  for (const field of ['locales', 'generatedFiles', 'managedFiles']) {
    if (!Array.isArray(manifest[field]) ||
        manifest[field].some((value) => typeof value !== 'string' || !value.trim())) {
      errors.push(`Manifest ${field} must be an array of non-empty strings.`);
    }
  }
  if (manifest.unavailableLocales !== undefined &&
      (!Array.isArray(manifest.unavailableLocales) ||
       manifest.unavailableLocales.some(
         (value) => typeof value !== 'string' || !value.trim()
       ))) {
    errors.push('Manifest unavailableLocales must be an array of non-empty strings.');
  }
  if (!manifest.resourcePaths || typeof manifest.resourcePaths !== 'object' ||
      Array.isArray(manifest.resourcePaths) ||
      Object.values(manifest.resourcePaths).some(
        (value) => typeof value !== 'string' || !value.trim()
      )) {
    errors.push('Manifest resourcePaths must be an object whose values are non-empty file paths.');
  }
  if (typeof manifest.adoptedExistingConfiguration !== 'boolean') {
    errors.push('Manifest adoptedExistingConfiguration must be a boolean.');
  }
  const verification = manifest.packageVerification;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    errors.push('Manifest packageVerification must be an object.');
  } else {
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
  }
  if (manifest.initializationEvidence !== undefined) {
    const evidence = manifest.initializationEvidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      errors.push('Manifest initializationEvidence must be an object.');
    } else {
      if (typeof evidence.file !== 'string' || !evidence.file.trim()) {
        errors.push('Manifest initializationEvidence.file must be a non-empty path.');
      }
      if (typeof evidence.marker !== 'string' || !evidence.marker.trim()) {
        errors.push('Manifest initializationEvidence.marker must be a non-empty string.');
      } else if (evidence.marker.length > 200) {
        errors.push('Manifest initializationEvidence.marker must not exceed 200 characters.');
      }
    }
  }
  if (manifest.bidirectionalReadiness !== undefined) {
    const readiness = manifest.bidirectionalReadiness;
    if (!readiness || typeof readiness !== 'object' || Array.isArray(readiness)) {
      errors.push('Manifest bidirectionalReadiness must be an object.');
    } else {
      if (!['ready', 'approved-with-limitations', 'pending-remediation'].includes(
        readiness.status
      )) {
        errors.push(
          'Manifest bidirectionalReadiness.status must be "ready", ' +
          '"approved-with-limitations", or "pending-remediation".'
        );
      }
      if (readiness.findings !== undefined && !Array.isArray(readiness.findings)) {
        errors.push('Manifest bidirectionalReadiness.findings must be an array.');
      }
      const renderedFindings = readiness.renderedFindings;
      if (renderedFindings !== undefined && !Array.isArray(renderedFindings)) {
        errors.push('Manifest bidirectionalReadiness.renderedFindings must be an array.');
      } else if (Array.isArray(renderedFindings)) {
        for (const [index, finding] of renderedFindings.entries()) {
          const prefix = `Manifest bidirectionalReadiness.renderedFindings[${index}]`;
          if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
            errors.push(`${prefix} must be an object.`);
            continue;
          }
          for (const field of ['caseId', 'rule', 'message', 'selector']) {
            if (typeof finding[field] !== 'string' || !finding[field].trim()) {
              errors.push(`${prefix}.${field} must be a non-empty string.`);
            }
          }
          if (!['error', 'review'].includes(finding.severity)) {
            errors.push(`${prefix}.severity must be "error" or "review".`);
          }
        }
        const renderedErrors = renderedFindings.some(
          (finding) => finding?.severity === 'error'
        );
        if (readiness.status === 'ready' && renderedFindings.length > 0) {
          errors.push(
            'Ready bidirectional readiness cannot contain unresolved renderedFindings.'
          );
        }
        if (readiness.status === 'approved-with-limitations' && renderedErrors) {
          errors.push(
            'Approved-with-limitations bidirectional readiness cannot contain rendered errors.'
          );
        }
        if (renderedErrors && readiness.status !== 'pending-remediation') {
          errors.push(
            'Rendered bidirectional errors require status "pending-remediation".'
          );
        }
      }
      if (readiness.status === 'pending-remediation' &&
          (!Array.isArray(manifest.unavailableLocales) ||
           manifest.unavailableLocales.length === 0)) {
        errors.push(
          'Pending bidirectional remediation requires at least one unavailable locale.'
        );
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
  if (path.isAbsolute(evidence.file)) {
    return {
      provided: true,
      valid: false,
      reason: 'initialization evidence file must be repository-relative',
    };
  }

  const resolvedRoot = path.resolve(projectRoot);
  const evidencePath = path.resolve(resolvedRoot, evidence.file);
  const rootPrefix = `${resolvedRoot}${path.sep}`;
  if (evidencePath !== resolvedRoot && !evidencePath.startsWith(rootPrefix)) {
    return {
      provided: true,
      valid: false,
      reason: 'initialization evidence file must remain inside the project root',
    };
  }
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

function packageDependencies(projectRoot) {
  const packageJson = readJson(path.join(projectRoot, 'package.json')) || {};
  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
  };
}

function detectFramework(projectRoot) {
  const dependencies = packageDependencies(projectRoot);
  const evidence = [];
  const candidates = [];

  if (dependencies.react && dependencies['react-dom']) {
    candidates.push('react');
    evidence.push({ framework: 'react', kind: 'primary', detail: 'react and react-dom dependencies' });
  }
  if (dependencies.vue) {
    candidates.push('vue');
    evidence.push({ framework: 'vue', kind: 'primary', detail: 'vue dependency' });
  }
  if (dependencies['@angular/core']) {
    candidates.push('angular');
    evidence.push({ framework: 'angular', kind: 'primary', detail: '@angular/core dependency' });
  }
  if (dependencies.astro) {
    candidates.push('astro');
    evidence.push({ framework: 'astro', kind: 'primary', detail: 'astro dependency' });
  }

  const primaryConfigChecks = [
    ['angular', 'angular.json'],
    ['astro', 'astro.config.mjs'],
    ['astro', 'astro.config.js'],
    ['astro', 'astro.config.ts'],
  ];
  for (const [framework, relativePath] of primaryConfigChecks) {
    if (fs.existsSync(path.join(projectRoot, relativePath))) {
      candidates.push(framework);
      evidence.push({ framework, kind: 'primary', detail: relativePath });
    }
  }

  const uniqueCandidates = [...new Set(candidates)];
  return {
    framework: uniqueCandidates.length === 1 ? uniqueCandidates[0] : null,
    candidates: uniqueCandidates,
    ambiguous: uniqueCandidates.length > 1,
    unsupported: uniqueCandidates.length === 0,
    evidence,
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

function getLocaleMetadata(locale) {
  let canonical;
  let parsed;
  try {
    [canonical] = Intl.getCanonicalLocales(locale);
    parsed = new Intl.Locale(canonical);
  } catch {
    // Private-use-only tags such as x-contoso are valid BCP-47 identifiers but
    // do not carry script metadata from which a direction can be derived.
    return {
      locale,
      language: null,
      script: null,
      region: null,
      direction: 'ltr',
      directionSource: 'private-use-default',
    };
  }

  const maximized = parsed.maximize();
  const script = parsed.script || maximized.script || null;
  if (script && RTL_SCRIPTS.has(script)) {
    return {
      locale: canonical,
      language: parsed.language,
      script,
      region: parsed.region || maximized.region || null,
      direction: 'rtl',
      directionSource: parsed.script ? 'explicit-script' : 'likely-script',
    };
  }
  if (script) {
    return {
      locale: canonical,
      language: parsed.language,
      script,
      region: parsed.region || maximized.region || null,
      direction: 'ltr',
      directionSource: parsed.script ? 'explicit-script' : 'likely-script',
    };
  }

  const textInfo = typeof parsed.getTextInfo === 'function'
    ? parsed.getTextInfo()
    : parsed.textInfo;
  const direction = ['rtl', 'ltr'].includes(textInfo?.direction)
    ? textInfo.direction
    : 'ltr';
  return {
    locale: canonical,
    language: parsed.language,
    script: null,
    region: parsed.region || null,
    direction,
    directionSource: textInfo?.direction ? 'intl-text-info' : 'unknown-default',
  };
}

function getLocaleDirection(locale) {
  return getLocaleMetadata(locale).direction;
}

function classifyLocaleDirections(locales) {
  const entries = locales.map((locale) => getLocaleMetadata(locale));
  const directions = [...new Set(entries.map((entry) => entry.direction))].sort();
  return {
    classification: directions.length > 1 ? 'mixed' : `${directions[0] || 'ltr'}-only`,
    directions,
    locales: entries,
  };
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
  const metadata = getLocaleMetadata(locale);
  return {
    ...validation,
    locale,
    language: metadata.language,
    script: metadata.script,
    region: metadata.region,
    direction: metadata.direction,
    directionSource: metadata.directionSource,
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
  if (manifest) conflicts.push(...validateLocalizationManifestShape(manifest));
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
    conflicts.push(`manifest package "${manifestPackage}" is not installed`);
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

  // Preserve every source rather than only the inferred winner. A manifest can
  // claim runtime mode while stale @angular/localize/angular.json evidence
  // still leaves a dormant static implementation in the project.
  const modeEvidence = [];
  if (manifestMode) {
    modeEvidence.push({
      mode: manifestMode,
      source: MANIFEST_NAME,
      detail: `manifest mode "${manifestMode}"`,
    });
  }
  for (const packageName of packages) {
    modeEvidence.push({
      mode: KNOWN_PACKAGES[packageName].mode,
      source: 'package',
      detail: packageName,
    });
  }
  if (angularI18n) {
    modeEvidence.push({
      mode: 'static',
      source: 'angular.json',
      detail: 'Angular i18n build configuration',
    });
  }
  if (astroConfig) {
    modeEvidence.push({
      mode: 'static',
      source: astroConfig,
      detail: 'Astro i18n configuration',
    });
  }
  const detectedEvidenceModes = [...new Set(modeEvidence.map((entry) => entry.mode))];
  if (manifestMode && detectedEvidenceModes.some((mode) => mode !== manifestMode)) {
    conflicts.push(
      `manifest mode "${manifestMode}" conflicts with detected ` +
      `${detectedEvidenceModes.filter((mode) => mode !== manifestMode).join('/')} mode evidence`
    );
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
  const unavailableModeEvidence = implementationFramework
    ? modeEvidence.filter((entry) =>
        !getLocalizationModeAvailability(implementationFramework, entry.mode).available
      )
    : [];
  for (const mode of [...new Set(unavailableModeEvidence.map((entry) => entry.mode))]) {
    const availability = getLocalizationModeAvailability(implementationFramework, mode);
    const sources = unavailableModeEvidence
      .filter((entry) => entry.mode === mode)
      .map((entry) => entry.detail)
      .join(', ');
    conflicts.push(`${availability.reason} Detected evidence: ${sources}.`);
  }
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
    modeEvidence,
    unavailableModeEvidence,
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
    signals.selector ||= /LanguageSelector|language selector|locale-switcher|switchLanguage|changeLanguage|setActiveLang|setLocale|getRelativeLocaleUrl|hreflang/i.test(text);
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
  return {
    projectRoot: resolvedRoot,
    framework,
    availability: framework.framework
      ? getFrameworkLocalizationAvailability(framework.framework)
      : null,
    siteLanguage: detectSiteLanguage(resolvedRoot, framework.framework),
    localization: detectLocalization(resolvedRoot),
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
  if (args.command === 'mode-availability' && args.framework !== undefined) {
    const result = args.mode === undefined
      ? getFrameworkLocalizationAvailability(args.framework)
      : getLocalizationModeAvailability(args.framework, args.mode);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = args.mode === undefined
      ? (result.supported ? 0 : 1)
      : (result.available ? 0 : 1);
    return;
  }
  process.stderr.write(
    'Usage: localization-config.js inspect --projectRoot <path> | ' +
    'validate-locales --locales <comma-separated-tags> | ' +
    'resolve-locale --locale <language-tag> | ' +
    'mode-availability --framework <framework> [--mode <runtime|static>]\n'
  );
  process.exitCode = 1;
}

if (require.main === module) runCli();

module.exports = {
  DEFAULT_SOURCE_SCAN_LIMITS,
  LOCALIZATION_CAPABILITIES,
  MANIFEST_NAME,
  KNOWN_PACKAGES,
  classifyLocaleDirections,
  detectFramework,
  detectLocalization,
  detectSiteLanguage,
  getFrameworkLocalizationAvailability,
  getLocaleDirection,
  getLocaleMetadata,
  getLocalizationModeAvailability,
  inspectProject,
  loadRegistry,
  resolveLocale,
  validateLocalizationManifestShape,
  validateLocales,
  verifyInitializationEvidence,
  protectedTokenSignature,
  extractIcuSignature,
  discoverLocalizationImplementation,
};
