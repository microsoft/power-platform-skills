'use strict';

const DEFERRABLE_RULES = new Set([
  'directional-physical-css',
  'directional-physical-utility',
  'directional-physical-shorthand',
  'fixed-direction',
]);

function partitionDeferredFindings(findings, recordedFindings, unavailableLocales) {
  const unavailable = new Set(unavailableLocales || []);
  const records = (recordedFindings || []).filter(
    (finding) =>
      finding &&
      typeof finding.file === 'string' &&
      Number.isInteger(finding.line) &&
      typeof finding.rule === 'string' &&
      typeof finding.message === 'string' &&
      typeof finding.fingerprint === 'string'
  );
  const unmatchedRecorded = [...records];
  for (const finding of findings) {
    const recordIndex = unmatchedRecorded.findIndex(
      (recorded) => sameSourceFinding(recorded, finding)
    );
    if (recordIndex !== -1) unmatchedRecorded.splice(recordIndex, 1);
  }

  const remainingDeferrals = records.filter(
    (finding) =>
      finding.severity === 'error' &&
      DEFERRABLE_RULES.has(finding.rule) &&
      Array.isArray(finding.affectedLocales) &&
      finding.affectedLocales.length > 0 &&
      finding.affectedLocales.every((locale) => unavailable.has(locale))
  );
  const blocking = [];
  const deferred = [];
  for (const finding of findings.filter((item) => item.severity === 'error')) {
    // Consume a record once so a second declaration with the same identity is
    // still a new defect. Source context fingerprints prevent line reuse.
    const recordIndex = DEFERRABLE_RULES.has(finding.rule)
      ? remainingDeferrals.findIndex(
        (recorded) => sameSourceFinding(recorded, finding)
      )
      : -1;
    if (recordIndex === -1) {
      blocking.push(finding);
      continue;
    }
    remainingDeferrals.splice(recordIndex, 1);
    deferred.push(finding);
  }
  return {
    blocking,
    deferred,
    unmatchedRecorded,
  };
}

function sameSourceFinding(left, right) {
  return left.severity === right.severity &&
    left.rule === right.rule &&
    left.file === right.file &&
    left.line === right.line &&
    left.message === right.message &&
    left.fingerprint === right.fingerprint;
}

module.exports = {
  partitionDeferredFindings,
};
