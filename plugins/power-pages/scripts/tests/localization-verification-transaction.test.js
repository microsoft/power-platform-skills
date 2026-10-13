'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  AUDIT_LEASE_CONFLICT_CODE,
  TRANSACTION_AVAILABILITY_FILE,
  TRANSACTION_FILE,
  TRANSACTION_LOCK_FILE,
  TRANSACTION_LOCK_RECOVERY_FILE,
  abandonLocalizationVerificationAudit,
  beginLocalizationVerificationAudit,
  beginLocalizationVerification,
  extendLocalizationVerification,
  finalizeLocalizationVerification,
  formatManualAvailabilityRestore,
  markLocalizationVerificationFailed,
  markLocalizationVerificationPassed,
  readLocalizationVerificationTransaction,
  recoverAbandonedTransactionLock,
  validateTransactionAgainstManifest,
} = require('../lib/localization-verification-transaction');
const {
  validateLocalizationManifestShape,
} = require('../lib/localization-config');
const {
  computeVerificationInputFingerprint,
} = require('../lib/verification-evidence');
const {
  parseArgs: parseManagerArgs,
} = require('../manage-localization-verification');
const { createTempProject, writeProjectFile } = require('./test-utils');
const VERIFICATION_MANAGER_PATH =
  path.join(__dirname, '..', 'manage-localization-verification.js');

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    framework: 'react',
    mode: 'runtime',
    packageName: 'react-i18next',
    packageVersion: '^16.0.0',
    packageVerification: {
      status: 'verified',
      source: 'known-capability',
      license: 'MIT',
      licenseReview: { status: 'automatically-accepted' },
      artifact: {
        version: '16.0.0',
        registry: 'https://registry.npmjs.org/',
        tarballUrl:
          'https://registry.npmjs.org/react-i18next/-/react-i18next-16.0.0.tgz',
        integrity: 'sha512-dGVzdA==',
      },
    },
    locales: ['en-US', 'ar-SA'],
    defaultLocale: 'en-US',
    translationMethod: 'agent',
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    generatedFiles: [],
    managedFiles: ['src/i18n/localeAvailability.ts'],
    unavailableLocales: ['ar-SA'],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'pending-remediation' },
      },
      findings: [],
      renderedFindings: [],
    },
    adoptedExistingConfiguration: false,
    lastOperation: 'add-languages',
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

const AVAILABILITY_MODULE = 'src/i18n/localeAvailability.ts';
const CALENDAR_REVIEW_FINDING = {
  caseId: 'calendar--open--desktop--ar',
  rule: 'rendered-semantic-review',
  severity: 'review',
  message: 'Confirm that the calendar navigation remains understandable.',
  selector: '.calendar',
};

function availabilitySource(unavailableLocales) {
  return `const unavailableLocales = new Set(${JSON.stringify(
    unavailableLocales
  )});\n` +
    'export const isLocaleAvailable = (locale: string) => ' +
    '!unavailableLocales.has(locale);\n';
}

function writeManifest(projectRoot, value) {
  if (!fs.existsSync(path.join(projectRoot, AVAILABILITY_MODULE))) {
    writeProjectFile(
      projectRoot,
      AVAILABILITY_MODULE,
      availabilitySource(value.unavailableLocales || [])
    );
  }
  writeProjectFile(
    projectRoot,
    '.powerpages-localization.json',
    `${JSON.stringify(value, null, 2)}\n`
  );
}

// Exposing or hiding a locale edits both the manifest and the managed
// availability module, exactly as the add-localization workflow does.
function writeManifestAndAvailability(projectRoot, value) {
  writeProjectFile(
    projectRoot,
    AVAILABILITY_MODULE,
    availabilitySource(value.unavailableLocales || [])
  );
  writeManifest(projectRoot, value);
}

function verificationEvidence(
  profile = 'extensive',
  manualReview = [],
  reviewFindings = []
) {
  return {
    profile,
    representativeLocaleIds: { ltr: 'en', rtl: 'ar' },
    manualReview,
    reviewFindings,
    evidence: {
      schemaVersion: 1,
      inputFingerprint: 'a'.repeat(64),
      inputFingerprintWithoutAvailability: 'c'.repeat(64),
      specFingerprint: 'b'.repeat(64),
    },
  };
}

function currentVerificationEvidence(
  projectRoot,
  profile = 'extensive',
  manualReview = [],
  reviewFindings = []
) {
  const verification = verificationEvidence(
    profile,
    manualReview,
    reviewFindings
  );
  verification.evidence.inputFingerprint =
    computeVerificationInputFingerprint(projectRoot);
  verification.evidence.inputFingerprintWithoutAvailability =
    computeVerificationInputFingerprint(projectRoot, {
      excludeAvailability: true,
    });
  return verification;
}

function writeExitedProcessLock(lockPath) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], `${process.pid}\\n`);",
      lockPath,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
}

test('begins an exclusive verification transaction from a fail-closed manifest', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());

  const transaction = beginLocalizationVerification(projectRoot, ['ar-sa']);

  assert.deepEqual(transaction.targetLocales, ['ar-SA']);
  assert.deepEqual(transaction.priorUnavailableLocales, ['ar-SA']);
  assert.equal(transaction.state, 'in-progress');
  assert.deepEqual(
    readLocalizationVerificationTransaction(projectRoot).transaction,
    transaction
  );
  assert.throws(
    () => beginLocalizationVerification(projectRoot, ['ar-SA']),
    /already exists/
  );
});

test('recovers a transaction lock left by an exited process', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const lockPath = path.join(projectRoot, TRANSACTION_LOCK_FILE);
  writeExitedProcessLock(lockPath);

  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);

  assert.equal(transaction.state, 'in-progress');
  assert.ok(!fs.existsSync(lockPath));
  assert.ok(!fs.existsSync(
    path.join(projectRoot, TRANSACTION_LOCK_RECOVERY_FILE)
  ));
});

test('--fail recovers an interrupted transaction with an abandoned lock', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeExitedProcessLock(path.join(projectRoot, TRANSACTION_LOCK_FILE));

  const result = spawnSync(
    process.execPath,
    [
      VERIFICATION_MANAGER_PATH,
      '--fail',
      '--projectRoot',
      projectRoot,
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readLocalizationVerificationTransaction(projectRoot).transaction.state,
    'remediation-required'
  );
});

test('does not reclaim a transaction lock owned by a live process', (t) => {
  const projectRoot = createTempProject(t);
  const lockPath = path.join(projectRoot, TRANSACTION_LOCK_FILE);
  fs.writeFileSync(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    processId: process.pid,
    token: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date().toISOString(),
  })}\n`);

  assert.equal(recoverAbandonedTransactionLock(projectRoot), false);
  assert.ok(fs.existsSync(lockPath));
});

test('finishes an interrupted abandoned-lock recovery claim', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const lockPath = path.join(projectRoot, TRANSACTION_LOCK_FILE);
  const recoveryPath =
    path.join(projectRoot, TRANSACTION_LOCK_RECOVERY_FILE);
  writeExitedProcessLock(lockPath);
  fs.linkSync(lockPath, recoveryPath);
  fs.unlinkSync(lockPath);

  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);

  assert.equal(transaction.state, 'in-progress');
  assert.ok(!fs.existsSync(recoveryPath));
  assert.ok(!fs.existsSync(lockPath));
});

test('allows only transaction targets to be temporarily exposed', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  const exposedManifest = manifest({ unavailableLocales: [] });

  assert.deepEqual(
    validateLocalizationManifestShape(exposedManifest, {
      verificationLocales: transaction.targetLocales,
    }),
    []
  );
  assert.match(
    validateLocalizationManifestShape(exposedManifest).join('\n'),
    /unavailableLocales must exactly match/
  );
  assert.deepEqual(
    validateTransactionAgainstManifest(
      transaction,
      exposedManifest,
      { requireExposed: true }
    ),
    []
  );
});

test('moves a failed browser run to remediation-required without deleting evidence', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);

  const failed = markLocalizationVerificationFailed(projectRoot);

  assert.equal(failed.runId, transaction.runId);
  assert.equal(failed.state, 'remediation-required');
  assert.ok(failed.failedAt);
  assert.ok(fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('failed verification restores manifest and runtime availability', (t) => {
  const projectRoot = createTempProject(t);
  const failClosedManifest = manifest({
    locales: ['en-US', 'ar-SA', 'he-IL'],
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
      'he-IL': 'src/i18n/locales/he-IL.json',
    },
    unavailableLocales: ['ar-SA', 'he-IL'],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'pending-remediation' },
        'he-IL': { status: 'pending-remediation' },
      },
      findings: [],
      renderedFindings: [],
    },
  });
  writeManifest(projectRoot, failClosedManifest);
  const availabilityPath =
    path.join(projectRoot, 'src/i18n/localeAvailability.ts');
  const failClosedSource = fs.readFileSync(availabilityPath, 'utf8');
  const transaction = beginLocalizationVerification(
    projectRoot,
    ['ar-SA', 'he-IL']
  );
  writeManifest(projectRoot, {
    ...failClosedManifest,
    unavailableLocales: [],
  });
  fs.writeFileSync(
    availabilityPath,
    "const unavailableLocales = new Set([]);\n" +
      'export const isLocaleAvailable = (locale: string) => ' +
      '!unavailableLocales.has(locale);\n',
    'utf8'
  );

  const failed = markLocalizationVerificationFailed(
    projectRoot,
    transaction.runId
  );
  const restoredManifest = JSON.parse(
    fs.readFileSync(
      path.join(projectRoot, '.powerpages-localization.json'),
      'utf8'
    )
  );

  assert.equal(failed.state, 'remediation-required');
  assert.equal(failed.manualAvailabilityRestore, undefined);
  assert.deepEqual(restoredManifest.unavailableLocales, ['ar-SA', 'he-IL']);
  for (const locale of ['ar-SA', 'he-IL']) {
    assert.equal(
      restoredManifest.bidirectionalReadiness.localeReadiness[locale].status,
      'pending-remediation'
    );
  }
  assert.equal(restoredManifest.bidirectionalReadiness.status, 'pending-remediation');
  assert.equal(fs.readFileSync(availabilityPath, 'utf8'), failClosedSource);
  assert.ok(
    fs.existsSync(path.join(projectRoot, TRANSACTION_AVAILABILITY_FILE))
  );

  assert.equal(
    markLocalizationVerificationFailed(projectRoot, transaction.runId).state,
    'remediation-required'
  );
  assert.equal(fs.readFileSync(availabilityPath, 'utf8'), failClosedSource);
});

function exposedTransactionProject(t) {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeManifestAndAvailability(projectRoot, manifest({ unavailableLocales: [] }));
  return { projectRoot, transaction };
}

function assertManualRestore(projectRoot, failed, reasonPattern) {
  assert.equal(failed.state, 'remediation-required');
  assert.deepEqual(failed.manualAvailabilityRestore.locales, ['ar-SA']);
  assert.match(failed.manualAvailabilityRestore.reason, reasonPattern);
  // Manual mode writes no source file, so the module still exposes ar-SA...
  assert.equal(
    fs.readFileSync(path.join(projectRoot, AVAILABILITY_MODULE), 'utf8'),
    availabilitySource([])
  );
  // ...while the manifest metadata is restored to its fail-closed state.
  const restored = JSON.parse(fs.readFileSync(
    path.join(projectRoot, '.powerpages-localization.json'),
    'utf8'
  ));
  assert.deepEqual(restored.unavailableLocales, ['ar-SA']);
  assert.equal(
    restored.bidirectionalReadiness.localeReadiness['ar-SA'].status,
    'pending-remediation'
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

test('falls back to a manual restore when the availability backup is missing', (t) => {
  const { projectRoot, transaction } = exposedTransactionProject(t);
  fs.unlinkSync(path.join(projectRoot, TRANSACTION_AVAILABILITY_FILE));

  const failed = markLocalizationVerificationFailed(
    projectRoot,
    transaction.runId
  );

  assertManualRestore(projectRoot, failed, /is missing/);
  assert.match(
    formatManualAvailabilityRestore(failed),
    /Exclude "ar-SA" in "src\/i18n\/localeAvailability\.ts", then run --finalize/
  );
  // A repeated --fail keeps the instruction and still writes no source file.
  assertManualRestore(
    projectRoot,
    markLocalizationVerificationFailed(projectRoot),
    /is missing/
  );
});

test('falls back to a manual restore when the availability backup changed', (t) => {
  const { projectRoot, transaction } = exposedTransactionProject(t);
  // For example, line endings rewritten by git after the backup was committed.
  fs.writeFileSync(
    path.join(projectRoot, TRANSACTION_AVAILABILITY_FILE),
    availabilitySource(['ar-SA']).replace(/\n/g, '\r\n')
  );

  const failed = markLocalizationVerificationFailed(
    projectRoot,
    transaction.runId
  );

  assertManualRestore(projectRoot, failed, /no longer matches its recorded checksum/);
});

test('never restores the backup to a path taken from a tampered transaction', (t) => {
  for (const tamperedPath of [
    '.git/config',
    'src/i18n/../../.git/config',
    'package.json',
  ]) {
    const { projectRoot, transaction } = exposedTransactionProject(t);
    const originalContent = 'ORIGINAL-CONTENT\n';
    const targetPath = writeProjectFile(
      projectRoot,
      path.posix.normalize(tamperedPath),
      originalContent
    );
    // The backup checksum matches, so only the path check can stop the write.
    const backupContent = 'BENIGN-TEST-MARKER\n';
    fs.writeFileSync(
      path.join(projectRoot, TRANSACTION_AVAILABILITY_FILE),
      backupContent
    );
    const transactionPath = path.join(projectRoot, TRANSACTION_FILE);
    const tampered = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    tampered.availabilitySnapshot = {
      path: tamperedPath,
      sha256: sha256(backupContent),
    };
    fs.writeFileSync(transactionPath, JSON.stringify(tampered));

    const failed = markLocalizationVerificationFailed(
      projectRoot,
      transaction.runId
    );

    assert.equal(
      fs.readFileSync(targetPath, 'utf8'),
      originalContent,
      `${tamperedPath} must not be overwritten`
    );
    assertManualRestore(projectRoot, failed, /snapshot path does not match/);
  }
});

test('never restores into a hidden directory even when the manifest names it', (t) => {
  const projectRoot = createTempProject(t);
  const hiddenModule = '.config/localeAvailability.ts';
  writeProjectFile(projectRoot, hiddenModule, availabilitySource(['ar-SA']));
  writeManifest(projectRoot, manifest({ managedFiles: [hiddenModule] }));
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeProjectFile(projectRoot, hiddenModule, availabilitySource([]));
  writeManifest(projectRoot, manifest({
    managedFiles: [hiddenModule],
    unavailableLocales: [],
  }));

  const failed = markLocalizationVerificationFailed(
    projectRoot,
    transaction.runId
  );

  assert.match(failed.manualAvailabilityRestore.reason, /hidden directory/);
  assert.equal(
    fs.readFileSync(path.join(projectRoot, hiddenModule), 'utf8'),
    availabilitySource([])
  );
});

test('rejects a stale audit outcome after a replacement transaction begins', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const stale = beginLocalizationVerification(projectRoot, ['ar-SA']);
  markLocalizationVerificationFailed(projectRoot, stale.runId);
  finalizeLocalizationVerification(projectRoot);
  const current = beginLocalizationVerification(projectRoot, ['ar-SA']);

  assert.throws(
    () => markLocalizationVerificationPassed(projectRoot, stale.runId),
    /runId changed/
  );
  assert.equal(
    readLocalizationVerificationTransaction(projectRoot).transaction.runId,
    current.runId
  );
  assert.equal(
    readLocalizationVerificationTransaction(projectRoot).transaction.state,
    'in-progress'
  );
});

test('failure wins if successful and failed outcomes race for one run', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeManifest(projectRoot, manifest({ unavailableLocales: [] }));
  markLocalizationVerificationPassed(
    projectRoot,
    transaction.runId,
    currentVerificationEvidence(projectRoot)
  );

  const failed = markLocalizationVerificationFailed(
    projectRoot,
    transaction.runId
  );

  assert.equal(failed.state, 'remediation-required');
  assert.equal(failed.verifiedAt, undefined);
  assert.throws(
    () => markLocalizationVerificationPassed(
      projectRoot,
      transaction.runId,
      verificationEvidence()
    ),
    /must be in-progress/
  );
});

test('blocks finalization while the rendered audit is active or abandoned', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  beginLocalizationVerificationAudit(projectRoot, transaction.runId);
  writeManifest(projectRoot, manifest({ unavailableLocales: [] }));
  markLocalizationVerificationPassed(
    projectRoot,
    transaction.runId,
    currentVerificationEvidence(projectRoot)
  );

  assert.throws(
    () => finalizeLocalizationVerification(projectRoot),
    /still active or was abandoned/
  );

  abandonLocalizationVerificationAudit(projectRoot, transaction.runId);
  writeManifest(projectRoot, manifest({
    unavailableLocales: [],
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
  }));
  finalizeLocalizationVerification(projectRoot);
  assert.ok(!fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('allows only one rendered audit lease for a transaction', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  beginLocalizationVerificationAudit(projectRoot, transaction.runId);

  assert.throws(() => {
    beginLocalizationVerificationAudit(projectRoot, transaction.runId);
  }, (error) => {
    assert.match(error.message, /already exists/);
    assert.equal(error.code, AUDIT_LEASE_CONFLICT_CODE);
    return true;
  });

  abandonLocalizationVerificationAudit(projectRoot, transaction.runId);
});

test('transaction manager rejects unknown and duplicate arguments', () => {
  assert.throws(
    () => parseManagerArgs([
      '--begin',
      '--projectRoot', '.',
      '--locales', 'ar-SA',
      '--bogus', 'value',
    ]),
    /Unknown or misplaced argument "--bogus"/
  );
  assert.throws(
    () => parseManagerArgs([
      '--begin',
      '--projectRoot', '.',
      '--projectRoot', '..',
      '--locales', 'ar-SA',
    ]),
    /"--projectRoot" may be specified only once/
  );
  assert.throws(
    () => parseManagerArgs([
      '--extend',
      '--projectRoot', '.',
      '--profile', 'standard',
    ]),
    /requires --profile extensive/
  );
  assert.deepEqual(
    parseManagerArgs([
      '--finalize',
      '--projectRoot', '.',
      '--manual-review-completed',
      '--rendered-review-completed',
    ]).manualReviewCompleted,
    true
  );
  assert.equal(
    parseManagerArgs([
      '--finalize',
      '--projectRoot', '.',
      '--rendered-review-completed',
    ]).renderedReviewCompleted,
    true
  );
});

test('finalizes a successful verification only after the manifest is ready', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeManifest(projectRoot, manifest({ unavailableLocales: [] }));
  markLocalizationVerificationPassed(
    projectRoot,
    null,
    currentVerificationEvidence(projectRoot)
  );
  writeManifest(projectRoot, manifest({
    unavailableLocales: [],
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
  }));

  finalizeLocalizationVerification(projectRoot);

  assert.ok(!fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
  assert.ok(
    !fs.existsSync(path.join(projectRoot, TRANSACTION_AVAILABILITY_FILE))
  );
});

test('blocks verified finalization before the maker decides an exposed target', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  const exposedManifest = manifest({ unavailableLocales: [] });
  writeManifestAndAvailability(projectRoot, exposedManifest);
  const verified = markLocalizationVerificationPassed(
    projectRoot,
    transaction.runId,
    currentVerificationEvidence(projectRoot)
  );

  // Still exposed and still pending: the maker decision was never recorded.
  assert.match(
    validateTransactionAgainstManifest(verified, exposedManifest).join('\n'),
    /verified target locale ar-SA must either be ready or approved-with-limitations and available, or remain pending-remediation and unavailable/
  );
  assert.throws(
    () => finalizeLocalizationVerification(projectRoot),
    /must be fully reconciled before finalization/
  );
  assert.ok(fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('finalizes a verified target that the maker keeps unavailable', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeManifestAndAvailability(projectRoot, manifest({ unavailableLocales: [] }));
  const verification = currentVerificationEvidence(
    projectRoot,
    'extensive',
    [],
    [CALENDAR_REVIEW_FINDING]
  );
  markLocalizationVerificationPassed(projectRoot, transaction.runId, verification);

  // "Save but keep locale unavailable": hide ar-SA again and keep its open
  // review finding as the remediation record.
  writeManifestAndAvailability(projectRoot, manifest({
    bidirectionalReadiness: {
      status: 'pending-remediation',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'pending-remediation' },
      },
      findings: [],
      renderedFindings: [{
        ...CALENDAR_REVIEW_FINDING,
        scope: 'locale',
        affectedLocales: ['ar-SA'],
      }],
    },
  }));
  // Hiding the locale changed availability inputs, so only the
  // availability-neutral fingerprint can accept this outcome.
  assert.notEqual(
    computeVerificationInputFingerprint(projectRoot),
    verification.evidence.inputFingerprint
  );

  finalizeLocalizationVerification(projectRoot);

  assert.ok(!fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
  assert.ok(
    !fs.existsSync(path.join(projectRoot, TRANSACTION_AVAILABILITY_FILE))
  );
});

test('finalizes one target enabled and another kept unavailable', (t) => {
  const projectRoot = createTempProject(t);
  const threeLocaleManifest = (unavailableLocales, hebrewStatus) => manifest({
    locales: ['en-US', 'ar-SA', 'he-IL'],
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
      'he-IL': 'src/i18n/locales/he-IL.json',
    },
    unavailableLocales,
    bidirectionalReadiness: {
      status: 'pending-remediation',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'pending-remediation' },
        'he-IL': { status: hebrewStatus },
      },
      findings: [],
      renderedFindings: [],
    },
  });
  writeManifest(
    projectRoot,
    threeLocaleManifest(['ar-SA', 'he-IL'], 'pending-remediation')
  );
  const transaction = beginLocalizationVerification(
    projectRoot,
    ['ar-SA', 'he-IL']
  );
  writeManifestAndAvailability(
    projectRoot,
    threeLocaleManifest([], 'pending-remediation')
  );
  markLocalizationVerificationPassed(
    projectRoot,
    transaction.runId,
    currentVerificationEvidence(projectRoot)
  );

  // Maker: enable Hebrew, keep Arabic unavailable.
  writeManifestAndAvailability(
    projectRoot,
    threeLocaleManifest(['ar-SA'], 'ready')
  );

  finalizeLocalizationVerification(projectRoot);

  assert.ok(!fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('rejects other input changes when a target is kept unavailable', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeManifestAndAvailability(projectRoot, manifest({ unavailableLocales: [] }));
  markLocalizationVerificationPassed(
    projectRoot,
    transaction.runId,
    currentVerificationEvidence(projectRoot)
  );
  writeManifestAndAvailability(projectRoot, manifest());
  writeProjectFile(
    projectRoot,
    'src/App.tsx',
    'export const App = () => <main>Changed after verification</main>;\n'
  );

  assert.throws(
    () => finalizeLocalizationVerification(projectRoot),
    /rendered evidence is stale.*inputs changed.*audit again/is
  );
  assert.ok(fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('requires availability-neutral evidence to keep a target unavailable', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeManifestAndAvailability(projectRoot, manifest({ unavailableLocales: [] }));
  const verification = currentVerificationEvidence(projectRoot);
  delete verification.evidence.inputFingerprintWithoutAvailability;
  markLocalizationVerificationPassed(projectRoot, transaction.runId, verification);
  writeManifestAndAvailability(projectRoot, manifest());

  assert.throws(
    () => finalizeLocalizationVerification(projectRoot),
    /predates finalization with target locales kept unavailable/
  );
  assert.ok(fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('finalizes a verified target approved with limitations and available', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeManifest(projectRoot, manifest({ unavailableLocales: [] }));
  markLocalizationVerificationPassed(
    projectRoot,
    transaction.runId,
    currentVerificationEvidence(projectRoot, 'extensive', [], [{
      caseId: 'calendar--open--desktop--ar',
      rule: 'third-party-surface-review',
      severity: 'review',
      message: 'The external calendar remains usable with limited RTL mirroring.',
      selector: '.calendar',
    }])
  );
  writeManifest(projectRoot, manifest({
    unavailableLocales: [],
    bidirectionalReadiness: {
      status: 'approved-with-limitations',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'approved-with-limitations' },
      },
      findings: [],
      renderedFindings: [{
        caseId: 'calendar--open--desktop--ar',
        rule: 'third-party-surface-review',
        severity: 'review',
        message: 'The external calendar remains usable with limited RTL mirroring.',
        selector: '.calendar',
        scope: 'locale',
        affectedLocales: ['ar-SA'],
        disposition: {
          status: 'maker-approved',
          impact: 'The calendar keeps its vendor-provided navigation layout.',
          evidence: 'docs/bidirectional-evidence/calendar-ar.png',
          approvedAt: '2026-09-03T00:00:00.000Z',
        },
      }],
    },
  }));

  finalizeLocalizationVerification(projectRoot);

  assert.ok(!fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('requires confirmation before dropping rendered review findings', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeManifest(projectRoot, manifest({ unavailableLocales: [] }));
  markLocalizationVerificationPassed(
    projectRoot,
    transaction.runId,
    currentVerificationEvidence(projectRoot, 'extensive', [], [{
      caseId: 'calendar--open--desktop--ar',
      rule: 'rendered-semantic-review',
      severity: 'review',
      message: 'Confirm that the calendar navigation remains understandable.',
      selector: '.calendar',
    }])
  );
  writeManifest(projectRoot, manifest({
    unavailableLocales: [],
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
  }));

  assert.throws(
    () => finalizeLocalizationVerification(projectRoot),
    /removed without confirming that the maker reviewed it/
  );
  const finalized = finalizeLocalizationVerification(projectRoot, {
    renderedReviewCompleted: true,
  });
  assert.ok(finalized.renderedReviewCompletedAt);
});

test('rejects verified finalization after project inputs change', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeManifest(projectRoot, manifest({ unavailableLocales: [] }));
  markLocalizationVerificationPassed(
    projectRoot,
    transaction.runId,
    currentVerificationEvidence(projectRoot)
  );
  writeManifest(projectRoot, manifest({
    unavailableLocales: [],
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
  }));
  writeProjectFile(
    projectRoot,
    'src/App.tsx',
    'export const App = () => <main>Changed after verification</main>;\n'
  );

  assert.throws(
    () => finalizeLocalizationVerification(projectRoot),
    /rendered evidence is stale.*inputs changed.*audit again/is
  );
  assert.ok(fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('finalizes failed verification only after fail-closed availability is restored', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  beginLocalizationVerification(projectRoot, ['ar-SA']);
  markLocalizationVerificationFailed(projectRoot);

  finalizeLocalizationVerification(projectRoot);

  assert.ok(!fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('requires manual review before finalizing standard verification', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(
    projectRoot,
    ['ar-SA'],
    'standard'
  );
  writeManifest(projectRoot, manifest({ unavailableLocales: [] }));
  markLocalizationVerificationPassed(
    projectRoot,
    transaction.runId,
    currentVerificationEvidence(projectRoot, 'standard', [{
      locale: 'ar-SA',
      componentId: 'calendar',
    }])
  );
  writeManifest(projectRoot, manifest({
    unavailableLocales: [],
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
  }));

  assert.throws(
    () => finalizeLocalizationVerification(projectRoot),
    /requires the maker to complete/
  );
  const finalized = finalizeLocalizationVerification(projectRoot, {
    manualReviewCompleted: true,
  });
  assert.ok(finalized.manualReviewCompletedAt);
});

test('extends verified standard verification to the extensive profile', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(
    projectRoot,
    ['ar-SA'],
    'standard'
  );
  markLocalizationVerificationPassed(
    projectRoot,
    transaction.runId,
    verificationEvidence('standard')
  );

  const extended = extendLocalizationVerification(projectRoot, 'extensive');

  assert.equal(extended.state, 'in-progress');
  assert.equal(extended.verificationProfile, 'extensive');
  assert.equal(extended.verification, undefined);
});

test('does not promote a remediation-required transaction without a new audit', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  beginLocalizationVerification(projectRoot, ['ar-SA']);
  markLocalizationVerificationFailed(projectRoot);
  writeManifest(projectRoot, manifest({
    unavailableLocales: [],
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
  }));

  assert.throws(
    () => finalizeLocalizationVerification(projectRoot),
    /must be restored to pending-remediation and unavailable/
  );
  assert.ok(fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('does not finalize an exposed locale that is still pending verification', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeManifest(projectRoot, manifest({ unavailableLocales: [] }));

  assert.throws(
    () => finalizeLocalizationVerification(projectRoot),
    /fully reconciled/
  );
  assert.ok(fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('does not finalize a ready locale before a successful rendered audit', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  beginLocalizationVerification(projectRoot, ['ar-SA']);
  writeManifest(projectRoot, manifest({
    unavailableLocales: [],
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
  }));

  assert.throws(
    () => finalizeLocalizationVerification(projectRoot),
    /cannot be finalized before the rendered audit/
  );
});
