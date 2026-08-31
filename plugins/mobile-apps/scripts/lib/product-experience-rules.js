'use strict';

// Semantic rules for the product-experience (UX DNA) contract.
//
// These run after schema validation and cover the constraints a JSON Schema subset cannot
// express: evidence/assumption coverage per dimension, internal consistency between related
// dimensions, and the guard that a domain word never stands in for a design decision.

const {
  EVIDENCE_REQUIRED_DIMENSIONS,
  EXPERIENCE_DIMENSIONS,
  finding,
} = require('./product-experience-contracts');

// Contexts where the device is used away from a desk. Used only to WARN when no matching
// accessibility priority was declared — the planner stays the decision maker.
const DEMANDING_ENVIRONMENTS = new Set(['field-outdoor', 'in-vehicle', 'on-the-floor']);
const DEMANDING_ENVIRONMENT_PRIORITIES = new Set([
  'large-touch-targets',
  'glove-friendly',
  'sunlight-legibility',
  'one-handed-reach',
  'high-contrast',
]);

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function validateExperienceSemantics(contract) {
  const errors = [];
  const warnings = [];

  const evidenceKeys = Object.keys(contract.promptEvidence || {});
  const assumedDimensions = new Set((contract.assumptions || []).map((entry) => entry.dimension));

  for (const key of evidenceKeys) {
    if (!EXPERIENCE_DIMENSIONS.includes(key)) {
      errors.push(finding(
        'unknown-evidence-dimension',
        `promptEvidence.${key} is not a product-experience dimension (expected one of: ${EXPERIENCE_DIMENSIONS.join(', ')})`,
      ));
    }
  }

  for (const key of Object.keys(contract.confidence?.byDimension || {})) {
    if (!EXPERIENCE_DIMENSIONS.includes(key)) {
      errors.push(finding(
        'unknown-confidence-dimension',
        `confidence.byDimension.${key} is not a product-experience dimension`,
      ));
    }
  }

  // A dimension that changes what the product IS must be traceable to something the user said,
  // or explicitly recorded as an assumption the user can reject.
  for (const dimension of EVIDENCE_REQUIRED_DIMENSIONS) {
    const hasEvidence = Array.isArray(contract.promptEvidence?.[dimension])
      && contract.promptEvidence[dimension].length > 0;
    if (!hasEvidence && !assumedDimensions.has(dimension)) {
      errors.push(finding(
        'unevidenced-dimension',
        `${dimension} has neither prompt evidence nor a recorded assumption; it must not be inferred silently`,
      ));
    }
  }

  // Low confidence without a recorded assumption hides the doubt from the approval gate.
  for (const [dimension, level] of Object.entries(contract.confidence?.byDimension || {})) {
    if (level === 'low' && !assumedDimensions.has(dimension)) {
      errors.push(finding(
        'low-confidence-without-assumption',
        `${dimension} is marked low confidence but has no assumption entry the user can correct`,
      ));
    }
  }

  const media = contract.mediaStrategy || {};
  if (media.necessity === 'essential') {
    if (!Array.isArray(media.types) || media.types.length === 0) {
      errors.push(finding(
        'essential-media-without-types',
        'mediaStrategy.necessity is "essential" but no media types are declared',
      ));
    }
    if (media.capture === 'none') {
      errors.push(finding(
        'essential-media-without-source',
        'mediaStrategy.necessity is "essential" but capture is "none", so no media can ever exist',
      ));
    }
  }
  if (media.necessity === 'none' && Array.isArray(media.types) && media.types.length > 0) {
    errors.push(finding(
      'media-types-without-necessity',
      'mediaStrategy declares media types while necessity is "none"',
    ));
  }

  const regionOrder = contract.firstViewport?.regionOrder || [];
  if (!regionOrder.includes('focal-content')) {
    errors.push(finding(
      'first-viewport-without-focal-content',
      'firstViewport.regionOrder must include "focal-content"; a first viewport with no focus is a generic shell',
    ));
  }
  if (!regionOrder.includes('primary-action')) {
    errors.push(finding(
      'first-viewport-without-primary-action',
      'firstViewport.regionOrder must include "primary-action"; the primary action must be reachable without scrolling',
    ));
  }
  if (regionOrder[0] === 'navigation') {
    warnings.push(finding(
      'navigation-first-viewport',
      'firstViewport.regionOrder starts with "navigation"; confirm the entry screen leads with content rather than chrome',
    ));
  }

  // Domain vocabulary names things. If a design rationale is nothing more than a domain word,
  // the design decision was never actually made.
  const vocabulary = new Set((contract.domainVocabulary || []).map(normalize));
  const rationale = normalize(contract.visualPersonality?.rationale);
  if (vocabulary.size && vocabulary.has(rationale)) {
    errors.push(finding(
      'domain-label-as-design-rationale',
      'visualPersonality.rationale restates a domainVocabulary term; vocabulary names the product, it does not choose its personality',
    ));
  }
  const signatureName = normalize(contract.signatureExperience?.name);
  const signatureReason = normalize(contract.signatureExperience?.whyNotGeneric);
  if (vocabulary.size && (vocabulary.has(signatureReason) || signatureReason === signatureName)) {
    errors.push(finding(
      'signature-experience-not-justified',
      'signatureExperience.whyNotGeneric must explain why a generic composition fails, not repeat the name or a domain term',
    ));
  }

  if (contract.source === 'reference-override' && !contract.referenceOverride) {
    errors.push(finding(
      'reference-override-without-detail',
      'source is "reference-override" but no referenceOverride fidelity/preservationIntent was supplied',
    ));
  }
  if (contract.source === 'brief' && contract.referenceOverride) {
    errors.push(finding(
      'reference-detail-without-source',
      'referenceOverride is present but source is "brief"; declare "brief-plus-reference" or "reference-override"',
    ));
  }

  const environment = contract.operatingContext?.environment;
  if (DEMANDING_ENVIRONMENTS.has(environment)) {
    const declared = (contract.accessibilityPriorities || []).some((entry) => DEMANDING_ENVIRONMENT_PRIORITIES.has(entry));
    if (!declared) {
      warnings.push(finding(
        'context-accessibility-gap',
        `operatingContext.environment is "${environment}" but no reach, contrast, or legibility priority was declared`,
      ));
    }
  }

  if (contract.operatingContext?.connectivity === 'offline-first'
    && contract.sessionPattern?.resumability === 'not-needed') {
    warnings.push(finding(
      'offline-without-resumability',
      'connectivity is "offline-first" while resumability is "not-needed"; confirm interrupted work can be discarded safely',
    ));
  }

  if (['intermittent', 'offline-first'].includes(contract.operatingContext?.connectivity)) {
    const connectivityEvidence = contract.promptEvidence?.operatingContext || [];
    const explicitConnectivity = connectivityEvidence.some((entry) => (
      /offline|intermittent|limited connectivity|poor (?:signal|network)|lose(?:s)? (?:signal|connection)|no signal/i
        .test(entry.text)
    ));
    const approvedAssumption = (contract.assumptions || []).some((assumption) => (
      ['operatingContext', 'connectivity'].includes(assumption.dimension)
        && assumption.approved === true
        && assumption.classification !== 'sample'
    ));
    if (!explicitConnectivity && !approvedAssumption) {
      errors.push(finding(
        'offline-without-evidence',
        `operatingContext.connectivity is "${contract.operatingContext.connectivity}" without explicit connectivity evidence or an approved operating-context assumption`,
      ));
    }
  }

  return { errors, warnings };
}

module.exports = { validateExperienceSemantics };
