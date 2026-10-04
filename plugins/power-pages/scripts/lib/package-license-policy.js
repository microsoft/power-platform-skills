'use strict';

const { sanitizeUntrustedText } = require('./safe-untrusted-text');

// This is deliberately an automatic-acceptance list, not a legal conclusion
// about every other license. Simple, common low-restriction SPDX identifiers
// can proceed unattended; missing, custom, compound, or other licenses require
// explicit maker review.
const AUTOMATICALLY_ACCEPTED_LICENSES = Object.freeze(new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
]));

function normalizeLicense(license) {
  if (typeof license === 'string') {
    return sanitizeUntrustedText(license.trim(), 200);
  }
  if (license && typeof license.type === 'string') {
    return sanitizeUntrustedText(license.type.trim(), 200);
  }
  return '';
}

function assessPackageLicense(licenseMetadata) {
  const license = normalizeLicense(licenseMetadata);
  if (!license ||
      /^SEE LICENSE IN\b/i.test(license) ||
      /^UNLICENSED$/i.test(license) ||
      /^UNKNOWN$/i.test(license)) {
    return {
      license: license || 'unknown',
      classification: 'unknown',
      automaticallyAccepted: false,
      reason:
        'The package does not publish a recognizable SPDX license identifier.',
    };
  }
  if (AUTOMATICALLY_ACCEPTED_LICENSES.has(license)) {
    return {
      license,
      classification: 'automatically-accepted',
      automaticallyAccepted: true,
      reason:
        'The package uses a documented low-restriction license accepted for unattended selection.',
    };
  }
  return {
    license,
    classification: 'review-required',
    automaticallyAccepted: false,
    reason:
      'The package license is not in the automatic-acceptance list and requires explicit review.',
  };
}

module.exports = {
  AUTOMATICALLY_ACCEPTED_LICENSES,
  assessPackageLicense,
  normalizeLicense,
};
