'use strict';

const fs = require('fs');
const path = require('path');
const {
  classifyLocaleDirections,
  getLocaleDirection,
  MANIFEST_NAME,
} = require('./localization-config');
const {
  auditBidirectionalReadiness,
} = require('./bidirectional-readiness');
const {
  validateLocalization,
} = require('../../skills/add-localization/scripts/validate-localization');

function validateSiteIntegrity(projectRoot) {
  const configPath = path.join(projectRoot, 'powerpages.config.json');
  if (!fs.existsSync(configPath)) {
    return {
      projectRoot,
      skipped: true,
      reason: 'Not a Power Pages code site.',
      errors: [],
      reviewFindings: [],
    };
  }

  const localizationErrors = validateLocalization(projectRoot);
  const bidiAudit = auditBidirectionalReadiness(projectRoot);
  const manifest = readJson(path.join(projectRoot, MANIFEST_NAME));
  const directionSet = Array.isArray(manifest?.locales)
    ? classifyLocaleDirections(manifest.locales)
    : null;
  const unavailableLocales = new Set(manifest?.unavailableLocales || []);
  const defaultDirection = manifest?.defaultLocale
    ? getLocaleDirection(manifest.defaultLocale)
    : null;
  const oppositeLocales = Array.isArray(manifest?.locales) && defaultDirection
    ? manifest.locales.filter((locale) => getLocaleDirection(locale) !== defaultDirection)
    : [];
  const remediationPending =
    manifest?.bidirectionalReadiness?.status === 'pending-remediation' &&
    directionSet?.classification === 'mixed' &&
    oppositeLocales.length > 0 &&
    oppositeLocales.every((locale) => unavailableLocales.has(locale)) &&
    localizationErrors.length === 0;
  const recordedFindings = remediationPending
    ? manifest.bidirectionalReadiness.findings || []
    : [];
  const {
    blocking: blockingBidiFindings,
    deferred,
  } = partitionDeferredFindings(
    bidiAudit.findings.filter((finding) => finding.severity === 'error'),
    recordedFindings
  );
  const deferredFindings = deferred.map((finding) => ({
    ...finding,
    severity: 'review',
    message: `Deferred while opposite-direction locales are unavailable: ${finding.message}`,
  }));

  return {
    projectRoot,
    skipped: false,
    errors: [...localizationErrors, ...blockingBidiFindings.map(formatBidiFinding)],
    reviewFindings: [
      ...bidiAudit.findings.filter((finding) => finding.severity === 'review'),
      ...deferredFindings,
    ],
  };
}

function partitionDeferredFindings(findings, recordedFindings) {
  const remainingRecords = [...recordedFindings];
  const blocking = [];
  const deferred = [];
  for (const finding of findings) {
    // Only a concrete layout blocker may be carried as pending work. Match the
    // complete scanner identity and consume it once, so changing or adding a
    // declaration on the same line is still a new blocking defect.
    const recordIndex = finding.rule === 'directional-physical-css'
      ? remainingRecords.findIndex((recorded) =>
        recorded &&
        recorded.rule === finding.rule &&
        recorded.file === finding.file &&
        recorded.line === finding.line &&
        recorded.message === finding.message
      )
      : -1;
    if (recordIndex === -1) {
      blocking.push(finding);
      continue;
    }
    remainingRecords.splice(recordIndex, 1);
    deferred.push(finding);
  }
  return { blocking, deferred };
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function formatBidiFinding(finding) {
  return `Bidirectional readiness ${finding.file}:${finding.line} ` +
    `[${finding.rule}]: ${finding.message}`;
}

module.exports = {
  partitionDeferredFindings,
  validateSiteIntegrity,
};
