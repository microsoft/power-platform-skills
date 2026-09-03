'use strict';

const fs = require('fs');
const path = require('path');
const {
  MANIFEST_NAME,
} = require('./localization-config');
const {
  auditBidirectionalReadiness,
} = require('./bidirectional-readiness');
const {
  partitionDeferredFindings,
} = require('./bidirectional-finding-disposition');
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
  const unavailableLocales = new Set(manifest?.unavailableLocales || []);
  const remediationPending =
    manifest?.bidirectionalReadiness?.status === 'pending-remediation' &&
    unavailableLocales.size > 0;
  const recordedFindings = remediationPending
    ? manifest.bidirectionalReadiness.findings || []
    : [];
  const {
    blocking: blockingBidiFindings,
    deferred,
  } = partitionDeferredFindings(
    bidiAudit.findings,
    recordedFindings,
    unavailableLocales
  );
  const deferredFindings = deferred.map((finding) => ({
    ...finding,
    severity: 'review',
    message: `Deferred while affected locales are unavailable: ${finding.message}`,
  }));
  const errors = [
    ...new Set([
      ...localizationErrors,
      ...blockingBidiFindings.map(formatBidiFinding),
    ]),
  ];

  return {
    projectRoot,
    skipped: false,
    errors,
    reviewFindings: [
      ...bidiAudit.findings.filter((finding) => finding.severity === 'review'),
      ...deferredFindings,
    ],
  };
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
