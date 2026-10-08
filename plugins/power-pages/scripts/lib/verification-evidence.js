'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  findLocaleAvailabilityModulePaths,
} = require('./localization-config');
const {
  FULL_VERIFICATION_PROFILES,
} = require('./localization-verification-profile');
const {
  summarizeFindings,
} = require('./rendered-bidirectional-readiness');

const MANIFEST_FILE = '.powerpages-localization.json';
const SOURCE_ROOTS = ['src', 'public'];
const SOURCE_FILES = [
  MANIFEST_FILE,
  'angular.json',
  'astro.config.js',
  'astro.config.mjs',
  'astro.config.ts',
  'index.html',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'powerpages.config.json',
  'tsconfig.json',
  'vite.config.js',
  'vite.config.ts',
  'yarn.lock',
];

// `excludeAvailability` produces a second fingerprint that ignores exactly the
// two inputs a maker decision to keep a verified locale unavailable edits:
// `unavailableLocales` in the manifest and the managed locale availability
// module. Hiding a locale is the fail-closed direction, so finalization can
// accept that change without new browser evidence while any other source,
// resource, dependency, or build-configuration change still invalidates it.
function computeVerificationInputFingerprint(projectRoot, options = {}) {
  const excludeAvailability = options.excludeAvailability === true;
  const excludedPaths = excludeAvailability
    ? readAvailabilityModulePaths(projectRoot)
    : new Set();
  const hash = crypto.createHash('sha256');
  for (const relativePath of collectVerificationInputs(projectRoot)) {
    const portablePath = relativePath.replaceAll(path.sep, '/');
    if (excludedPaths.has(portablePath)) continue;
    const absolutePath = path.join(projectRoot, relativePath);
    hash.update(portablePath);
    hash.update('\0');
    if (relativePath === MANIFEST_FILE) {
      hash.update(normalizeLocalizationManifest(absolutePath, {
        excludeAvailability,
      }));
    } else {
      hash.update(fs.readFileSync(absolutePath));
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function computeSpecFingerprint(spec) {
  return crypto
    .createHash('sha256')
    .update(stableStringify(spec))
    .digest('hex');
}

function createVerificationEvidence(projectRoot, spec) {
  return {
    schemaVersion: 1,
    inputFingerprint: computeVerificationInputFingerprint(projectRoot),
    inputFingerprintWithoutAvailability: computeVerificationInputFingerprint(
      projectRoot,
      { excludeAvailability: true }
    ),
    specFingerprint: computeSpecFingerprint(spec),
  };
}

// Reuse lets create-site skip repeating add-localization's browser run. That
// run must be complete and passed, and the project inputs must be unchanged.
// The run specification is intentionally not compared: add-localization's full
// run already covers every visible or interactive component under the same
// shared rules, so a matching plan adds no coverage proof. Only a targeted
// repair run is partial, so its evidence is refused.
function validateReusableVerificationReport(projectRoot, report) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return ['Rendered verification report must contain a JSON object.'];
  }
  const summaryClaimsFailure =
    report.summary?.errors !== 0 || report.summary?.failed !== 0;
  if (summaryClaimsFailure) {
    errors.push('Rendered verification report contains failed checks.');
  }
  const hasResults = Array.isArray(report.results) && report.results.length > 0;
  const hasFindings = Array.isArray(report.findings);
  if (!hasResults || !hasFindings) {
    errors.push(
      'Rendered verification report must contain detailed results and findings.'
    );
  } else {
    const malformedResult = report.results.some((result) =>
      !result || typeof result !== 'object' || Array.isArray(result) ||
      !isNonEmptyString(result.id) ||
      !['locale-smoke', 'component-state', 'locale-transition'].includes(
        result.type
      ) ||
      !Array.isArray(result.findings) ||
      !['passed', 'review', 'failed'].includes(result.status)
    );
    const malformedFinding = report.findings.some((finding) =>
      !finding || typeof finding !== 'object' || Array.isArray(finding) ||
      !isNonEmptyString(finding.caseId) ||
      !isNonEmptyString(finding.rule) ||
      !isNonEmptyString(finding.message) ||
      !['error', 'review'].includes(finding.severity)
    );
    if (malformedResult || malformedFinding) {
      errors.push(
        'Rendered verification report contains malformed detailed evidence.'
      );
    } else {
      const computedSummary = summarizeFindings(
        report.findings,
        report.results
      );
      const summaryMatches = report.summary &&
        typeof report.summary === 'object' &&
        !Array.isArray(report.summary) &&
        Object.entries(computedSummary).every(
          ([field, value]) => report.summary[field] === value
        );
      if (!summaryMatches) {
        errors.push(
          'Rendered verification report summary does not match its detailed evidence.'
        );
      }
      if (computedSummary.failed > 0 || computedSummary.errors > 0) {
        if (!summaryClaimsFailure) {
          errors.push('Rendered verification report contains failed checks.');
        }
      }
    }
  }
  if (!FULL_VERIFICATION_PROFILES.has(report.verification?.profile)) {
    errors.push(
      'Rendered verification report must come from a standard or extensive ' +
      'run; targeted repair evidence cannot be reused.'
    );
  }
  const evidence = report.verification?.evidence;
  if (!evidence || evidence.schemaVersion !== 1) {
    errors.push('Rendered verification report has no supported evidence fingerprint.');
    return errors;
  }
  const current = computeVerificationInputFingerprint(projectRoot);
  if (evidence.inputFingerprint !== current) {
    errors.push(
      'Rendered verification evidence is stale because project verification inputs changed.'
    );
  }
  return errors;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function collectVerificationInputs(projectRoot) {
  const files = [];
  for (const relativePath of SOURCE_FILES) {
    if (fs.existsSync(path.join(projectRoot, relativePath))) {
      files.push(relativePath);
    }
  }
  for (const root of SOURCE_ROOTS) {
    collectFiles(projectRoot, root, files);
  }
  return files.sort();
}

function collectFiles(projectRoot, relativePath, files) {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return;
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      collectFiles(projectRoot, child, files);
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
}

function normalizeLocalizationManifest(manifestPath, options = {}) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // Finalization changes readiness/disposition metadata after the browser
    // run without changing what the application builds or renders. Availability
    // remains included because exposing or hiding a locale changes behavior.
    delete manifest.updatedAt;
    delete manifest.bidirectionalReadiness;
    if (options.excludeAvailability === true) {
      delete manifest.unavailableLocales;
    }
    return stableStringify(manifest);
  } catch {
    return fs.readFileSync(manifestPath);
  }
}

function readAvailabilityModulePaths(projectRoot) {
  // The manifest is read only to learn which managed file is the availability
  // module. If it cannot be parsed, nothing is excluded, so any availability
  // change still makes the evidence stale (fail-closed).
  let manifest;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, MANIFEST_FILE), 'utf8')
    );
  } catch {
    return new Set();
  }
  return new Set(
    findLocaleAvailabilityModulePaths(manifest).map((relativePath) =>
      path.posix.normalize(relativePath.replace(/\\/g, '/'))
    )
  );
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  collectVerificationInputs,
  computeSpecFingerprint,
  computeVerificationInputFingerprint,
  createVerificationEvidence,
  validateReusableVerificationReport,
};
