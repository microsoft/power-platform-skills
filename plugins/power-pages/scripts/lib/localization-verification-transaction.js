'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  MANIFEST_NAME,
  findLocaleAvailabilityModulePaths,
  resolveLocale,
  resolveProjectRelativePath,
  validateLocalizationManifestShape,
} = require('./localization-config');
const {
  VERIFICATION_PROFILES,
} = require('./localization-verification-profile');
const {
  quoteUntrustedText,
  sanitizeUntrustedText,
} = require('./safe-untrusted-text');
const {
  computeVerificationInputFingerprint,
} = require('./verification-evidence');

const TRANSACTION_FILE = '.powerpages-localization-verification.json';
const TRANSACTION_LOCK_FILE = `${TRANSACTION_FILE}.lock`;
const TRANSACTION_LOCK_RECOVERY_FILE = `${TRANSACTION_LOCK_FILE}.recovery`;
const TRANSACTION_AUDIT_FILE = `${TRANSACTION_FILE}.audit`;
const TRANSACTION_AVAILABILITY_FILE = `${TRANSACTION_FILE}.availability`;
const AUDIT_LEASE_CONFLICT_CODE = 'LOCALIZATION_AUDIT_LEASE_CONFLICT';
const TRANSACTION_STATES = new Set([
  'in-progress',
  'verified',
  'remediation-required',
]);
const ENABLED_TARGET_STATUSES = new Set([
  'ready',
  'approved-with-limitations',
]);
const REVIEWABLE_TARGET_STATUSES = new Set([
  'pending-remediation',
  ...ENABLED_TARGET_STATUSES,
]);

function readLocalizationVerificationTransaction(projectRoot) {
  const transactionPath = path.join(projectRoot, TRANSACTION_FILE);
  if (!fs.existsSync(transactionPath)) return { transaction: null, errors: [] };
  let transaction;
  try {
    transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  } catch {
    return {
      transaction: null,
      errors: [`${TRANSACTION_FILE} is not valid JSON.`],
    };
  }
  return {
    transaction,
    errors: validateTransactionShape(transaction),
  };
}

function validateTransactionShape(transaction) {
  if (!transaction || typeof transaction !== 'object' ||
      Array.isArray(transaction)) {
    return [`${TRANSACTION_FILE} must contain a JSON object.`];
  }
  const errors = [];
  if (transaction.schemaVersion !== 1) {
    errors.push(`${TRANSACTION_FILE} schemaVersion must be 1.`);
  }
  if (!TRANSACTION_STATES.has(transaction.state)) {
    errors.push(
      `${TRANSACTION_FILE} state must be "in-progress" or ` +
      '"verified" or "remediation-required".'
    );
  }
  if (transaction.verificationProfile !== undefined &&
      !VERIFICATION_PROFILES.has(transaction.verificationProfile)) {
    errors.push(
      `${TRANSACTION_FILE} verificationProfile must be standard, extensive, or targeted.`
    );
  }
  if (typeof transaction.runId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(transaction.runId)) {
    errors.push(`${TRANSACTION_FILE} runId must be a UUID.`);
  }
  if (!isExactIsoDate(transaction.startedAt)) {
    errors.push(`${TRANSACTION_FILE} startedAt must be an ISO date-time.`);
  }
  if (transaction.state === 'verified' &&
      !isExactIsoDate(transaction.verifiedAt)) {
    errors.push(`${TRANSACTION_FILE} verifiedAt must be an ISO date-time.`);
  }
  if (transaction.state === 'verified') {
    if (!transaction.verification ||
        typeof transaction.verification !== 'object' ||
        Array.isArray(transaction.verification)) {
      errors.push(`${TRANSACTION_FILE} verified runs require verification evidence.`);
    } else if (transaction.verification.profile !==
        (transaction.verificationProfile || 'extensive')) {
      errors.push(
        `${TRANSACTION_FILE} verification evidence profile must match verificationProfile.`
      );
    }
  }
  if (transaction.state === 'remediation-required' &&
      !isExactIsoDate(transaction.failedAt)) {
    errors.push(`${TRANSACTION_FILE} failedAt must be an ISO date-time.`);
  }
  validateLocaleArray(transaction.targetLocales, 'targetLocales', errors, 1);
  validateLocaleArray(
    transaction.priorUnavailableLocales,
    'priorUnavailableLocales',
    errors,
    0
  );
  if (!transaction.availabilitySnapshot ||
      typeof transaction.availabilitySnapshot !== 'object' ||
      Array.isArray(transaction.availabilitySnapshot) ||
      typeof transaction.availabilitySnapshot.path !== 'string' ||
      !transaction.availabilitySnapshot.path.trim() ||
      !/^[0-9a-f]{64}$/.test(transaction.availabilitySnapshot.sha256 || '')) {
    errors.push(
      `${TRANSACTION_FILE} availabilitySnapshot must identify the captured ` +
      'fail-closed locale availability module.'
    );
  }
  if (Array.isArray(transaction.targetLocales) &&
      Array.isArray(transaction.priorUnavailableLocales)) {
    for (const locale of transaction.targetLocales) {
      if (!transaction.priorUnavailableLocales.includes(locale)) {
        errors.push(
          `${TRANSACTION_FILE} target locale ${locale} must have been ` +
          'unavailable when verification began.'
        );
      }
    }
  }
  return errors;
}

function validateTransactionAgainstManifest(
  transaction,
  manifest,
  options = {}
) {
  const errors = validateTransactionShape(transaction);
  if (errors.length > 0) return errors;
  const manifestLocales = new Set(manifest?.locales || []);
  const unavailable = new Set(manifest?.unavailableLocales || []);
  for (const locale of transaction.targetLocales) {
    if (!manifestLocales.has(locale)) {
      errors.push(
        `${TRANSACTION_FILE} target locale ${locale} is not configured in ` +
        `${MANIFEST_NAME}.`
      );
      continue;
    }
    const status =
      manifest?.bidirectionalReadiness?.localeReadiness?.[locale]?.status;
    if (options.requireExposed) {
      if (transaction.state !== 'in-progress') {
        errors.push(
          `${TRANSACTION_FILE} must be in-progress before rendered verification.`
        );
      }
      if (status !== 'pending-remediation') {
        errors.push(
          `${TRANSACTION_FILE} target locale ${locale} must remain ` +
          'pending-remediation until verification passes.'
        );
      }
      if (unavailable.has(locale)) {
        errors.push(
          `${TRANSACTION_FILE} target locale ${locale} must be temporarily ` +
          'available through the normal application path during verification.'
        );
      }
    }
    if (transaction.state === 'remediation-required' &&
        !options.requireExposed) {
      if (status !== 'pending-remediation' || !unavailable.has(locale)) {
        errors.push(
          `${TRANSACTION_FILE} failed target locale ${locale} must be restored ` +
          'to pending-remediation and unavailable before finalization.'
        );
      }
    }
    if (transaction.state === 'verified' && !options.requireExposed) {
      const exposed = !unavailable.has(locale);
      if (options.allowVerifiedPendingReview) {
        // Phase 6 site integrity runs before the maker decides whether review
        // findings are resolved or retained, so the verified target can remain
        // temporarily exposed and pending until that decision.
        if (!REVIEWABLE_TARGET_STATUSES.has(status) || !exposed) {
          errors.push(
            `${TRANSACTION_FILE} verified target locale ${locale} must ` +
            'remain available with a reviewable readiness status.'
          );
        }
      } else if (!isEnabledTarget(status, exposed) &&
          !isKeptUnavailableTarget(status, exposed)) {
        errors.push(
          `${TRANSACTION_FILE} verified target locale ${locale} must either ` +
          'be ready or approved-with-limitations and available, or remain ' +
          'pending-remediation and unavailable, before finalization.'
        );
      }
    }
  }
  const targetSet = new Set(transaction.targetLocales);
  const priorNonTargets = transaction.priorUnavailableLocales
    .filter((locale) => !targetSet.has(locale))
    .sort();
  const currentNonTargets = [...unavailable]
    .filter((locale) => !targetSet.has(locale))
    .sort();
  if (JSON.stringify(priorNonTargets) !== JSON.stringify(currentNonTargets)) {
    errors.push(
      `${TRANSACTION_FILE} cannot change the availability of locales outside ` +
      'targetLocales.'
    );
  }
  return errors;
}

function validateVerifiedTransactionForFinalization(
  projectRoot,
  transaction,
  manifest
) {
  const errors = validateTransactionAgainstManifest(transaction, manifest);
  if (errors.length > 0) return errors;
  if (transaction.state !== 'verified') {
    return [
      `${TRANSACTION_FILE} must be verified before the final site-integrity gate.`,
    ];
  }
  return validateCurrentVerificationEvidence(projectRoot, transaction, {
    allowAvailabilityChanges:
      findKeptUnavailableTargets(transaction, manifest).length > 0,
  });
}

// After the maker decision, every verified target ends in exactly one of two
// states: enabled (ready or approved-with-limitations, and available) or kept
// unavailable (still pending-remediation and back in unavailableLocales).
// Keeping a target unavailable is the fail-closed direction, so it needs no new
// rendered evidence. The manage CLI's full validate-localization run before
// finalization separately proves that the managed availability module and
// selectors exclude every unavailable locale.
function isEnabledTarget(status, exposed) {
  return exposed && ENABLED_TARGET_STATUSES.has(status);
}

function isKeptUnavailableTarget(status, exposed) {
  return !exposed && status === 'pending-remediation';
}

function findKeptUnavailableTargets(transaction, manifest) {
  const unavailable = new Set(manifest?.unavailableLocales || []);
  const localeReadiness =
    manifest?.bidirectionalReadiness?.localeReadiness || {};
  return transaction.targetLocales.filter((locale) =>
    isKeptUnavailableTarget(
      localeReadiness[locale]?.status,
      !unavailable.has(locale)
    )
  );
}

function validateVerifiedTransactionForReview(
  projectRoot,
  transaction,
  manifest
) {
  const errors = validateTransactionAgainstManifest(transaction, manifest, {
    allowVerifiedPendingReview: true,
  });
  if (errors.length > 0) return errors;
  if (transaction.state !== 'verified') {
    return [
      `${TRANSACTION_FILE} must be verified before the final site-integrity gate.`,
    ];
  }
  return validateCurrentVerificationEvidence(projectRoot, transaction);
}

function validateCurrentVerificationEvidence(
  projectRoot,
  transaction,
  options = {}
) {
  const evidence = transaction.verification?.evidence;
  if (!evidence || evidence.schemaVersion !== 1 ||
      !/^[0-9a-f]{64}$/.test(evidence.inputFingerprint || '')) {
    return [
      `${TRANSACTION_FILE} verified evidence must contain a valid ` +
      'project input fingerprint.',
    ];
  }
  const staleEvidenceError =
    `${TRANSACTION_FILE} rendered evidence is stale because project ` +
    'verification inputs changed after the successful audit. Run the ' +
    'rendered audit again before finalization.';
  if (options.allowAvailabilityChanges === true) {
    // Returning a deferred target to unavailable edits only unavailableLocales
    // and the managed availability module, so compare the fingerprint that
    // excludes exactly those inputs. Any other change is still stale.
    if (!/^[0-9a-f]{64}$/.test(
      evidence.inputFingerprintWithoutAvailability || ''
    )) {
      return [
        `${TRANSACTION_FILE} verified evidence predates finalization with ` +
        'target locales kept unavailable. Run --fail and finalize this run, ' +
        'or rerun the rendered audit.',
      ];
    }
    const currentFingerprint = computeVerificationInputFingerprint(
      projectRoot,
      { excludeAvailability: true }
    );
    return evidence.inputFingerprintWithoutAvailability === currentFingerprint
      ? []
      : [staleEvidenceError];
  }
  const currentFingerprint = computeVerificationInputFingerprint(projectRoot);
  if (evidence.inputFingerprint !== currentFingerprint) {
    return [staleEvidenceError];
  }
  return [];
}

function validateRenderedReviewFindingReconciliation(
  transaction,
  manifest,
  options = {}
) {
  const reviewFindings = transaction.verification?.reviewFindings;
  if (reviewFindings === undefined) return [];
  if (!Array.isArray(reviewFindings)) {
    return [
      `${TRANSACTION_FILE} rendered review findings must be an array.`,
    ];
  }
  const manifestFindings =
    manifest.bidirectionalReadiness?.renderedFindings || [];
  const unavailable = new Set(manifest.unavailableLocales || []);
  const localeReadiness =
    manifest.bidirectionalReadiness?.localeReadiness || {};
  // An open review finding may stay only while every locale it affects is kept
  // unavailable; it is then the remediation record for those hidden locales.
  const affectsOnlyUnavailableLocales = (finding) =>
    Array.isArray(finding.affectedLocales) &&
    finding.affectedLocales.length > 0 &&
    finding.affectedLocales.every((locale) =>
      isKeptUnavailableTarget(
        localeReadiness[locale]?.status,
        !unavailable.has(locale)
      )
    );
  const errors = [];
  for (const [index, finding] of reviewFindings.entries()) {
    const prefix = `${TRANSACTION_FILE} verification.reviewFindings[${index}]`;
    if (!isStoredRenderedReviewFinding(finding)) {
      errors.push(`${prefix} is malformed.`);
      continue;
    }
    const retained = manifestFindings.find((candidate) =>
      sameRenderedFinding(candidate, finding)
    );
    if (retained?.disposition?.status === 'maker-approved') continue;
    if (retained && affectsOnlyUnavailableLocales(retained)) continue;
    if (retained) {
      errors.push(
        `${prefix} remains in the manifest without a maker-approved ` +
        'disposition while an affected locale is available.'
      );
    } else if (options.renderedReviewCompleted !== true) {
      errors.push(
        `${prefix} was removed without confirming that the maker reviewed it.`
      );
    }
  }
  return errors;
}

function isStoredRenderedReviewFinding(finding) {
  return finding &&
    typeof finding === 'object' &&
    !Array.isArray(finding) &&
    finding.severity === 'review' &&
    ['caseId', 'rule', 'message', 'selector'].every(
      (field) => typeof finding[field] === 'string' && finding[field].trim()
    );
}

function sameRenderedFinding(left, right) {
  return ['caseId', 'rule', 'severity', 'message', 'selector'].every(
    (field) => left?.[field] === right?.[field]
  );
}

function beginLocalizationVerification(
  projectRoot,
  targetLocales,
  verificationProfile = 'extensive'
) {
  return withTransactionLock(projectRoot, () => {
    const transactionPath = path.join(projectRoot, TRANSACTION_FILE);
    if (fs.existsSync(transactionPath)) {
      throw new Error(
        `${TRANSACTION_FILE} already exists. Recover or finalize that run first.`
      );
    }
    const availabilityBackupPath =
      path.join(projectRoot, TRANSACTION_AVAILABILITY_FILE);
    if (fs.existsSync(availabilityBackupPath)) {
      fs.unlinkSync(availabilityBackupPath);
    }
    const manifest = readManifest(projectRoot);
    const manifestErrors = validateLocalizationManifestShape(
      manifest,
      projectRoot
    );
    if (manifestErrors.length > 0) {
      throw new Error(
        `${MANIFEST_NAME} must be valid before verification begins:\n- ` +
        manifestErrors.join('\n- ')
      );
    }
    const normalizedTargets = normalizeLocales(targetLocales);
    if (normalizedTargets.length === 0) {
      throw new Error('At least one target locale is required.');
    }
    if (!VERIFICATION_PROFILES.has(verificationProfile) ||
        verificationProfile === 'targeted') {
      throw new Error(
        'New locale verification must use the standard or extensive profile.'
      );
    }
    const unavailable = new Set(manifest.unavailableLocales || []);
    for (const locale of normalizedTargets) {
      if (!manifest.locales.includes(locale)) {
        throw new Error(`Verification target ${locale} is not configured.`);
      }
      if (locale === manifest.defaultLocale) {
        throw new Error('The default locale cannot be a verification target.');
      }
      if (!unavailable.has(locale) ||
          manifest.bidirectionalReadiness.localeReadiness[locale]?.status !==
            'pending-remediation') {
        throw new Error(
          `Verification target ${locale} must begin pending-remediation and unavailable.`
        );
      }
    }
    const availability = readLocaleAvailabilityModule(projectRoot, manifest);
    const transaction = {
      schemaVersion: 1,
      state: 'in-progress',
      runId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      targetLocales: normalizedTargets,
      priorUnavailableLocales: [...unavailable].sort(),
      verificationProfile,
      availabilitySnapshot: {
        path: availability.relativePath,
        sha256: sha256(availability.source),
      },
    };
    publishExclusiveText(
      availabilityBackupPath,
      availability.source,
      `${TRANSACTION_AVAILABILITY_FILE} already exists.`
    );
    try {
      publishExclusiveJson(
        transactionPath,
        transaction,
        `${TRANSACTION_FILE} already exists. Recover or finalize that run first.`
      );
    } catch (error) {
      fs.unlinkSync(availabilityBackupPath);
      throw error;
    }
    return transaction;
  });
}

function extendLocalizationVerification(
  projectRoot,
  verificationProfile = 'extensive'
) {
  return withTransactionLock(projectRoot, () => {
    const transaction = readCurrentTransaction(projectRoot);
    if (transaction.state !== 'verified' ||
        (transaction.verificationProfile || 'extensive') !== 'standard' ||
        verificationProfile !== 'extensive') {
      throw new Error(
        'Only a verified standard run can be extended to extensive verification.'
      );
    }
    const updated = {
      ...transaction,
      state: 'in-progress',
      verificationProfile,
      extendedAt: new Date().toISOString(),
    };
    delete updated.verifiedAt;
    delete updated.verification;
    atomicWriteJson(path.join(projectRoot, TRANSACTION_FILE), updated);
    return updated;
  });
}

function beginLocalizationVerificationAudit(projectRoot, expectedRunId) {
  return withTransactionLock(projectRoot, () => {
    const transaction = readCurrentTransaction(projectRoot, expectedRunId);
    if (transaction.state !== 'in-progress') {
      throw new Error(
        `${TRANSACTION_FILE} must be in-progress before its audit can begin.`
      );
    }
    const lease = {
      runId: transaction.runId,
      processId: process.pid,
      startedAt: new Date().toISOString(),
    };
    publishExclusiveJson(
      path.join(projectRoot, TRANSACTION_AUDIT_FILE),
      lease,
      `${TRANSACTION_AUDIT_FILE} already exists. Recover that audit first.`,
      AUDIT_LEASE_CONFLICT_CODE
    );
    return lease;
  });
}

function endLocalizationVerificationAudit(projectRoot, expectedRunId) {
  return withTransactionLock(projectRoot, () => {
    const lease = readAuditLease(projectRoot);
    if (!lease) return;
    if (lease.runId !== expectedRunId) {
      throw new Error(
        `${TRANSACTION_AUDIT_FILE} belongs to a different verification run.`
      );
    }
    fs.unlinkSync(path.join(projectRoot, TRANSACTION_AUDIT_FILE));
  });
}

function markLocalizationVerificationFailed(projectRoot, expectedRunId = null) {
  return withTransactionLock(projectRoot, () => {
    const transaction = readCurrentTransaction(projectRoot, expectedRunId);
    const manualRestore =
      restoreFailClosedAvailability(projectRoot, transaction);
    const updated = transaction.state === 'remediation-required'
      ? { ...transaction }
      : {
        ...transaction,
        state: 'remediation-required',
        failedAt: new Date().toISOString(),
      };
    delete updated.verifiedAt;
    delete updated.verification;
    // Persist the manual step so a repeated --fail, the audit runner, or a
    // person inspecting the transaction can still see which locales to hide.
    if (manualRestore) {
      updated.manualAvailabilityRestore = manualRestore;
    } else {
      delete updated.manualAvailabilityRestore;
    }
    atomicWriteJson(path.join(projectRoot, TRANSACTION_FILE), updated);
    return updated;
  });
}

function markLocalizationVerificationPassed(
  projectRoot,
  expectedRunId = null,
  verification = null
) {
  return withTransactionLock(projectRoot, () => {
    const transaction = readCurrentTransaction(projectRoot, expectedRunId);
    if (transaction.state !== 'in-progress') {
      throw new Error(
        `${TRANSACTION_FILE} must be in-progress before it can be verified.`
      );
    }
    if (!verification ||
        verification.profile !==
          (transaction.verificationProfile || 'extensive')) {
      throw new Error(
        `${TRANSACTION_FILE} requires verification evidence for its active profile.`
      );
    }
    const updated = {
      ...transaction,
      state: 'verified',
      verifiedAt: new Date().toISOString(),
      verification,
    };
    atomicWriteJson(path.join(projectRoot, TRANSACTION_FILE), updated);
    return updated;
  });
}

function finalizeLocalizationVerification(projectRoot, options = {}) {
  return withTransactionLock(projectRoot, () => {
    const transaction = readCurrentTransaction(projectRoot);
    const lease = readAuditLease(projectRoot);
    if (lease) {
      throw new Error(
        `${TRANSACTION_AUDIT_FILE} shows that rendered verification is still ` +
        'active or was abandoned. Mark the run failed before finalization.'
      );
    }
    const manifest = readManifest(projectRoot);
    const manifestErrors = validateLocalizationManifestShape(manifest);
    if (manifestErrors.length > 0) {
      throw new Error(
        `${MANIFEST_NAME} must be fully reconciled before finalization:\n- ` +
        manifestErrors.join('\n- ')
      );
    }
    const relationErrors = transaction.state === 'verified'
      ? validateVerifiedTransactionForFinalization(
        projectRoot,
        transaction,
        manifest
      )
      : validateTransactionAgainstManifest(transaction, manifest);
    if (relationErrors.length > 0) {
      throw new Error(relationErrors.join('\n'));
    }
    if (transaction.state === 'in-progress') {
      throw new Error(
        `${TRANSACTION_FILE} cannot be finalized before the rendered audit ` +
        'records a verified or remediation-required result.'
      );
    }
    const manualReview = transaction.verification?.manualReview || [];
    if ((transaction.verificationProfile || 'extensive') === 'standard' &&
        manualReview.length > 0 &&
        options.manualReviewCompleted !== true) {
      throw new Error(
        `${TRANSACTION_FILE} standard verification requires the maker to ` +
        'complete the generated complex-component locale review or extend the ' +
        'run to extensive verification.'
      );
    }
    const reviewErrors = validateRenderedReviewFindingReconciliation(
      transaction,
      manifest,
      options
    );
    if (reviewErrors.length > 0) {
      throw new Error(reviewErrors.join('\n'));
    }
    if (options.manualReviewCompleted === true) {
      transaction.manualReviewCompletedAt = new Date().toISOString();
    }
    if (options.renderedReviewCompleted === true) {
      transaction.renderedReviewCompletedAt = new Date().toISOString();
    }
    fs.unlinkSync(path.join(projectRoot, TRANSACTION_FILE));
    const availabilityBackupPath =
      path.join(projectRoot, TRANSACTION_AVAILABILITY_FILE);
    if (fs.existsSync(availabilityBackupPath)) {
      fs.unlinkSync(availabilityBackupPath);
    }
    return transaction;
  });
}

function listVerificationTransactionArtifacts(projectRoot) {
  return fs.readdirSync(projectRoot).filter((name) =>
    name === TRANSACTION_FILE ||
    name === TRANSACTION_LOCK_FILE ||
    name === TRANSACTION_LOCK_RECOVERY_FILE ||
    name === TRANSACTION_AUDIT_FILE ||
    name === TRANSACTION_AVAILABILITY_FILE ||
    name.startsWith(`${TRANSACTION_FILE}.candidate-`) ||
    name.startsWith(`${TRANSACTION_LOCK_FILE}.candidate-`)
  );
}

function abandonLocalizationVerificationAudit(projectRoot, expectedRunId) {
  endLocalizationVerificationAudit(projectRoot, expectedRunId);
}

function readAuditLease(projectRoot) {
  const auditPath = path.join(projectRoot, TRANSACTION_AUDIT_FILE);
  if (!fs.existsSync(auditPath)) return null;
  let lease;
  try {
    lease = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  } catch {
    throw new Error(`${TRANSACTION_AUDIT_FILE} is not valid JSON.`);
  }
  if (!lease || typeof lease !== 'object' || Array.isArray(lease) ||
      typeof lease.runId !== 'string' ||
      !Number.isInteger(lease.processId) ||
      !isExactIsoDate(lease.startedAt)) {
    throw new Error(`${TRANSACTION_AUDIT_FILE} is invalid.`);
  }
  return lease;
}

function readCurrentTransaction(projectRoot, expectedRunId = null) {
  const { transaction, errors } =
    readLocalizationVerificationTransaction(projectRoot);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  if (!transaction) {
    throw new Error(`${TRANSACTION_FILE} does not exist.`);
  }
  if (expectedRunId && transaction.runId !== expectedRunId) {
    throw new Error(
      `${TRANSACTION_FILE} runId changed while the rendered audit was running.`
    );
  }
  return transaction;
}

function withTransactionLock(projectRoot, operation) {
  const lockPath = path.join(projectRoot, TRANSACTION_LOCK_FILE);
  const owner = {
    schemaVersion: 1,
    processId: process.pid,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const recoveryPath =
      path.join(projectRoot, TRANSACTION_LOCK_RECOVERY_FILE);
    if (fs.existsSync(recoveryPath)) {
      recoverAbandonedTransactionLock(projectRoot);
      if (fs.existsSync(recoveryPath)) {
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          10
        );
        continue;
      }
    }
    if (tryAcquireTransactionLock(lockPath, owner)) {
      acquired = true;
      break;
    }
    recoverAbandonedTransactionLock(projectRoot);
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      10
    );
  }
  if (!acquired) {
    throw new Error(`${TRANSACTION_FILE} is busy; retry the operation.`);
  }
  try {
    return operation();
  } finally {
    removeOwnedTransactionLock(lockPath, owner.token);
  }
}

function tryAcquireTransactionLock(lockPath, owner) {
  const candidate =
    `${lockPath}.candidate-${process.pid}-${crypto.randomUUID()}`;
  writeSyncedFile(candidate, `${JSON.stringify(owner)}\n`);
  try {
    fs.linkSync(candidate, lockPath);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

function recoverAbandonedTransactionLock(projectRoot) {
  const lockPath = path.join(projectRoot, TRANSACTION_LOCK_FILE);
  const recoveryPath =
    path.join(projectRoot, TRANSACTION_LOCK_RECOVERY_FILE);
  if (fs.existsSync(recoveryPath)) {
    return finishTransactionLockRecovery(lockPath, recoveryPath);
  }
  if (!fs.existsSync(lockPath)) return false;
  const owner = readTransactionLockOwner(lockPath);
  if (!owner || isProcessRunning(owner.processId)) return false;
  try {
    // The fixed recovery hard link is an atomic claim. Every contender honors
    // it, so only one process can retire this exact abandoned lock.
    fs.linkSync(lockPath, recoveryPath);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ENOENT') return false;
    throw error;
  }
  return finishTransactionLockRecovery(lockPath, recoveryPath);
}

function finishTransactionLockRecovery(lockPath, recoveryPath) {
  const owner = readTransactionLockOwner(recoveryPath);
  if (!owner || isProcessRunning(owner.processId)) return false;
  if (fs.existsSync(lockPath) &&
      pathsReferenceSameLock(lockPath, recoveryPath)) {
    fs.unlinkSync(lockPath);
  }
  fs.unlinkSync(recoveryPath);
  return true;
}

function pathsReferenceSameLock(lockPath, recoveryPath) {
  const lockOwner = readTransactionLockOwner(lockPath);
  const recoveryOwner = readTransactionLockOwner(recoveryPath);
  if (lockOwner?.token && recoveryOwner?.token) {
    return lockOwner.token === recoveryOwner.token;
  }
  const lockStat = fs.statSync(lockPath);
  const recoveryStat = fs.statSync(recoveryPath);
  return lockStat.dev === recoveryStat.dev && lockStat.ino === recoveryStat.ino;
}

function readTransactionLockOwner(lockPath) {
  let content;
  try {
    content = fs.readFileSync(lockPath, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (/^\d+$/.test(content)) {
    return { processId: Number(content), token: null };
  }
  try {
    const owner = JSON.parse(content);
    if (!owner || owner.schemaVersion !== 1 ||
        !Number.isInteger(owner.processId) || owner.processId <= 0 ||
        typeof owner.token !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(owner.token) ||
        !isExactIsoDate(owner.createdAt)) {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

function isProcessRunning(processId) {
  if (processId === process.pid) return true;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'EINVAL') return false;
    return true;
  }
}

function removeOwnedTransactionLock(lockPath, token) {
  const owner = readTransactionLockOwner(lockPath);
  if (owner?.token !== token) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function readManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`${MANIFEST_NAME} is missing or is not valid JSON.`);
  }
  return manifest;
}

function normalizeLocales(locales) {
  if (!Array.isArray(locales)) return [];
  const normalized = [];
  for (const value of locales) {
    const resolved = resolveLocale(value);
    if (!resolved.valid || !resolved.locale) {
      throw new Error(`Invalid verification target locale: ${value}`);
    }
    if (!normalized.includes(resolved.locale)) normalized.push(resolved.locale);
  }
  return normalized.sort();
}

function readLocaleAvailabilityModule(projectRoot, manifest) {
  const availabilityPaths = findLocaleAvailabilityModulePaths(manifest);
  if (availabilityPaths.length !== 1) {
    throw new Error(
      'Verification requires exactly one managed locale availability module.'
    );
  }
  const relativePath = availabilityPaths[0];
  const resolved = resolveProjectRelativePath(projectRoot, relativePath);
  if (!resolved.valid || !fs.existsSync(resolved.path)) {
    throw new Error(
      `Locale availability module ${relativePath} is missing or unsafe.`
    );
  }
  return {
    relativePath,
    source: fs.readFileSync(resolved.path, 'utf8'),
  };
}

// `--fail` must leave every target locale fail-closed, but the transaction file
// and its `.availability` backup are ordinary project files that can be
// deleted, edited, or crafted. The only file this function may write is the
// managed locale availability module that the manifest identifies by name, and
// only with backup content whose checksum still matches the transaction. In
// every other case it writes no source file and returns a manual-restore
// description; the manage CLI's full validate-localization run then blocks
// finalization until that module excludes every target locale again.
function restoreFailClosedAvailability(projectRoot, transaction) {
  const manifest = readManifest(projectRoot);
  const plan = planAvailabilityRestore(projectRoot, transaction, manifest);
  if (plan.automatic) {
    // Restore the runtime boundary before metadata so any interrupted rollback
    // leaves the locale inaccessible even if the manifest update has not landed.
    atomicWriteText(plan.path, plan.source);
  }

  const localeReadiness =
    manifest?.bidirectionalReadiness?.localeReadiness;
  if (!localeReadiness || typeof localeReadiness !== 'object' ||
      Array.isArray(localeReadiness)) {
    throw new Error(
      `${MANIFEST_NAME} does not contain locale readiness state to restore.`
    );
  }
  const unavailable = new Set([
    ...(Array.isArray(manifest.unavailableLocales)
      ? manifest.unavailableLocales
      : []),
    ...transaction.priorUnavailableLocales,
    ...transaction.targetLocales,
  ]);
  const restoredLocaleReadiness = { ...localeReadiness };
  for (const locale of transaction.targetLocales) {
    restoredLocaleReadiness[locale] = {
      ...(restoredLocaleReadiness[locale] || {}),
      status: 'pending-remediation',
    };
  }
  const restoredManifest = {
    ...manifest,
    unavailableLocales: [...unavailable].sort(),
    bidirectionalReadiness: {
      ...manifest.bidirectionalReadiness,
      status: 'pending-remediation',
      localeReadiness: restoredLocaleReadiness,
    },
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(path.join(projectRoot, MANIFEST_NAME), restoredManifest);
  return plan.automatic
    ? null
    : {
      // Informational only and later shown to the agent, so bound and
      // neutralize the project-controlled path rather than trusting it.
      path: plan.relativePath === null
        ? null
        : sanitizeUntrustedText(plan.relativePath, 300),
      locales: [...transaction.targetLocales],
      reason: plan.reason,
    };
}

function planAvailabilityRestore(projectRoot, transaction, manifest) {
  const manual = (relativePath, reason) => ({
    automatic: false,
    relativePath,
    reason,
  });
  const candidates = findLocaleAvailabilityModulePaths(manifest);
  if (candidates.length !== 1) {
    return manual(
      null,
      `${MANIFEST_NAME} does not identify exactly one managed locale ` +
      'availability module'
    );
  }
  const relativePath = candidates[0];
  const portablePath = toPortableRelativePath(relativePath);
  // Hidden directories such as .git or .github hold tooling state and
  // configuration, never site source, so they are never restore targets.
  if (portablePath.split('/').some((segment) => segment.startsWith('.'))) {
    return manual(
      relativePath,
      'the managed locale availability module is inside a hidden directory'
    );
  }
  const target = resolveProjectRelativePath(projectRoot, relativePath);
  if (!target.valid) {
    return manual(
      relativePath,
      'the managed locale availability module path is unsafe'
    );
  }
  if (!isMissingOrRegularFile(target.path)) {
    return manual(
      relativePath,
      'the managed locale availability module is not a regular file'
    );
  }
  const snapshot = transaction.availabilitySnapshot;
  if (toPortableRelativePath(snapshot.path) !== portablePath) {
    return manual(
      relativePath,
      `the ${TRANSACTION_FILE} snapshot path does not match the managed ` +
      'locale availability module'
    );
  }
  const backupPath = path.join(projectRoot, TRANSACTION_AVAILABILITY_FILE);
  const backupState = regularFileState(backupPath);
  if (backupState !== 'file') {
    return manual(
      relativePath,
      backupState === 'missing'
        ? `${TRANSACTION_AVAILABILITY_FILE} is missing`
        : `${TRANSACTION_AVAILABILITY_FILE} is not a regular file`
    );
  }
  const source = fs.readFileSync(backupPath, 'utf8');
  if (sha256(source) !== snapshot.sha256) {
    return manual(
      relativePath,
      `${TRANSACTION_AVAILABILITY_FILE} no longer matches its recorded checksum`
    );
  }
  return { automatic: true, path: target.path, relativePath, source };
}

function toPortableRelativePath(relativePath) {
  return path.posix.normalize(String(relativePath).replace(/\\/g, '/'));
}

// lstat (not stat) so a symbolic link is never treated as the file it targets.
function regularFileState(filePath) {
  try {
    return fs.lstatSync(filePath).isFile() ? 'file' : 'other';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function isMissingOrRegularFile(filePath) {
  return regularFileState(filePath) !== 'other';
}

// Values read back from the transaction file are project-controlled, so every
// field is bounded and neutralized before it reaches agent-visible output.
function formatManualAvailabilityRestore(transaction) {
  const restore = transaction?.manualAvailabilityRestore;
  if (!restore || typeof restore !== 'object') return null;
  const locales = Array.isArray(restore.locales)
    ? restore.locales.map((locale) => quoteUntrustedText(locale, 100))
      .join(', ')
    : 'the transaction target locales';
  const target = restore.path
    ? quoteUntrustedText(restore.path, 300)
    : 'the managed locale availability module';
  return 'Automatic locale availability restore was skipped because ' +
    `${quoteUntrustedText(restore.reason, 300)}. Exclude ${locales} in ` +
    `${target}, then run --finalize; finalization validates that every ` +
    'unavailable locale is excluded.';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateLocaleArray(value, field, errors, minimumLength) {
  if (!Array.isArray(value) || value.length < minimumLength) {
    errors.push(
      `${TRANSACTION_FILE} ${field} must be an array containing at least ` +
      `${minimumLength} locale${minimumLength === 1 ? '' : 's'}.`
    );
    return;
  }
  const normalized = [];
  for (const locale of value) {
    const resolved = resolveLocale(locale);
    if (!resolved.valid || resolved.locale !== locale) {
      errors.push(
        `${TRANSACTION_FILE} ${field} must contain canonical BCP-47 locale tags.`
      );
      return;
    }
    normalized.push(locale);
  }
  if (new Set(normalized).size !== normalized.length) {
    errors.push(`${TRANSACTION_FILE} ${field} must not contain duplicates.`);
  }
}

function isExactIsoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const normalized = value.includes('.')
    ? value
    : value.replace(/Z$/, '.000Z');
  return Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === normalized;
}

function publishExclusiveJson(
  filePath,
  value,
  existsMessage,
  existsCode = null
) {
  publishExclusiveText(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    existsMessage,
    existsCode
  );
}

function publishExclusiveText(
  filePath,
  content,
  existsMessage,
  existsCode = null
) {
  const candidate = `${filePath}.candidate-${process.pid}-${crypto.randomUUID()}`;
  writeSyncedFile(candidate, content);
  try {
    fs.linkSync(candidate, filePath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      const existsError = new Error(existsMessage);
      if (existsCode) existsError.code = existsCode;
      throw existsError;
    }
    throw error;
  } finally {
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

function atomicWriteJson(filePath, value) {
  atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWriteText(filePath, content) {
  const candidate = `${filePath}.candidate-${process.pid}-${crypto.randomUUID()}`;
  writeSyncedFile(candidate, content);
  try {
    fs.renameSync(candidate, filePath);
  } finally {
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

function writeSyncedFile(filePath, content) {
  const descriptor = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = {
  AUDIT_LEASE_CONFLICT_CODE,
  TRANSACTION_AUDIT_FILE,
  TRANSACTION_AVAILABILITY_FILE,
  TRANSACTION_FILE,
  TRANSACTION_LOCK_FILE,
  TRANSACTION_LOCK_RECOVERY_FILE,
  abandonLocalizationVerificationAudit,
  beginLocalizationVerificationAudit,
  beginLocalizationVerification,
  extendLocalizationVerification,
  endLocalizationVerificationAudit,
  finalizeLocalizationVerification,
  formatManualAvailabilityRestore,
  listVerificationTransactionArtifacts,
  markLocalizationVerificationFailed,
  markLocalizationVerificationPassed,
  recoverAbandonedTransactionLock,
  readLocalizationVerificationTransaction,
  validateTransactionAgainstManifest,
  validateVerifiedTransactionForFinalization,
  validateVerifiedTransactionForReview,
  validateTransactionShape,
};
