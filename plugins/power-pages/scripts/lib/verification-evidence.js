'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOURCE_ROOTS = ['src', 'public'];
const SOURCE_FILES = [
  '.powerpages-localization.json',
  'angular.json',
  'astro.config.mjs',
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

function computeVerificationInputFingerprint(projectRoot) {
  const hash = crypto.createHash('sha256');
  for (const relativePath of collectVerificationInputs(projectRoot)) {
    const absolutePath = path.join(projectRoot, relativePath);
    hash.update(relativePath.replaceAll(path.sep, '/'));
    hash.update('\0');
    if (relativePath === '.powerpages-localization.json') {
      hash.update(normalizeLocalizationManifest(absolutePath));
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
    specFingerprint: computeSpecFingerprint(spec),
  };
}

function validateReusableVerificationReport(projectRoot, report) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return ['Rendered verification report must contain a JSON object.'];
  }
  if (report.summary?.errors !== 0 || report.summary?.failed !== 0) {
    errors.push('Rendered verification report contains failed checks.');
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

function normalizeLocalizationManifest(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // Finalization changes readiness/disposition metadata after the browser
    // run without changing what the application builds or renders. Availability
    // remains included because exposing or hiding a locale changes behavior.
    delete manifest.updatedAt;
    delete manifest.bidirectionalReadiness;
    return stableStringify(manifest);
  } catch {
    return fs.readFileSync(manifestPath);
  }
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
