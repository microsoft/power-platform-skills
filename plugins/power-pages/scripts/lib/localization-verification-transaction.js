'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  MANIFEST_NAME,
  resolveLocale,
  validateLocalizationManifestShape,
} = require('./localization-config');

const TRANSACTION_FILE = '.powerpages-localization-verification.json';
const TRANSACTION_LOCK_FILE = `${TRANSACTION_FILE}.lock`;
const TRANSACTION_AUDIT_FILE = `${TRANSACTION_FILE}.audit`;
const TRANSACTION_STATES = new Set([
  'in-progress',
  'verified',
  'remediation-required',
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

function beginLocalizationVerification(projectRoot, targetLocales) {
  const transactionPath = path.join(projectRoot, TRANSACTION_FILE);
  if (fs.existsSync(transactionPath)) {
    throw new Error(
      `${TRANSACTION_FILE} already exists. Recover or finalize that run first.`
    );
  }
  const manifest = readManifest(projectRoot);
  const manifestErrors = validateLocalizationManifestShape(manifest);
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
  const transaction = {
    schemaVersion: 1,
    state: 'in-progress',
    runId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    targetLocales: normalizedTargets,
    priorUnavailableLocales: [...unavailable].sort(),
  };
  publishExclusiveJson(
    transactionPath,
    transaction,
    `${TRANSACTION_FILE} already exists. Recover or finalize that run first.`
  );
  return transaction;
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
      `${TRANSACTION_AUDIT_FILE} already exists. Recover that audit first.`
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
    if (transaction.state === 'remediation-required') return transaction;
    const updated = {
      ...transaction,
      state: 'remediation-required',
      failedAt: new Date().toISOString(),
    };
    delete updated.verifiedAt;
    atomicWriteJson(path.join(projectRoot, TRANSACTION_FILE), updated);
    return updated;
  });
}

function markLocalizationVerificationPassed(projectRoot, expectedRunId = null) {
  return withTransactionLock(projectRoot, () => {
    const transaction = readCurrentTransaction(projectRoot, expectedRunId);
    if (transaction.state !== 'in-progress') {
      throw new Error(
        `${TRANSACTION_FILE} must be in-progress before it can be verified.`
      );
    }
    const updated = {
      ...transaction,
      state: 'verified',
      verifiedAt: new Date().toISOString(),
    };
    atomicWriteJson(path.join(projectRoot, TRANSACTION_FILE), updated);
    return updated;
  });
}

function finalizeLocalizationVerification(projectRoot) {
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
    const relationErrors = validateTransactionAgainstManifest(
      transaction,
      manifest
    );
    if (relationErrors.length > 0) {
      throw new Error(relationErrors.join('\n'));
    }
    if (transaction.state === 'in-progress') {
      throw new Error(
        `${TRANSACTION_FILE} cannot be finalized before the rendered audit ` +
        'records a verified or remediation-required result.'
      );
    }
    fs.unlinkSync(path.join(projectRoot, TRANSACTION_FILE));
    return transaction;
  });
}

function listVerificationTransactionArtifacts(projectRoot) {
  return fs.readdirSync(projectRoot).filter((name) =>
    name === TRANSACTION_FILE ||
    name === TRANSACTION_LOCK_FILE ||
    name === TRANSACTION_AUDIT_FILE ||
    name.startsWith(`${TRANSACTION_FILE}.candidate-`)
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
  let descriptor;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      descriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Never remove a lock by pathname after observing it: another process
      // could replace it between the check and unlink, defeating exclusivity.
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        10
      );
    }
  }
  if (descriptor === undefined) {
    throw new Error(`${TRANSACTION_FILE} is busy; retry the operation.`);
  }
  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
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

function publishExclusiveJson(filePath, value, existsMessage) {
  const candidate = `${filePath}.candidate-${process.pid}-${crypto.randomUUID()}`;
  writeSyncedFile(candidate, `${JSON.stringify(value, null, 2)}\n`);
  try {
    fs.linkSync(candidate, filePath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(existsMessage);
    }
    throw error;
  } finally {
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

function atomicWriteJson(filePath, value) {
  const candidate = `${filePath}.candidate-${process.pid}-${crypto.randomUUID()}`;
  writeSyncedFile(candidate, `${JSON.stringify(value, null, 2)}\n`);
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
  TRANSACTION_FILE,
  abandonLocalizationVerificationAudit,
  beginLocalizationVerificationAudit,
  beginLocalizationVerification,
  endLocalizationVerificationAudit,
  finalizeLocalizationVerification,
  listVerificationTransactionArtifacts,
  markLocalizationVerificationFailed,
  markLocalizationVerificationPassed,
  readLocalizationVerificationTransaction,
  validateTransactionAgainstManifest,
  validateTransactionShape,
};
