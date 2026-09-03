'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  TRANSACTION_FILE,
  abandonLocalizationVerificationAudit,
  beginLocalizationVerificationAudit,
  beginLocalizationVerification,
  finalizeLocalizationVerification,
  markLocalizationVerificationFailed,
  markLocalizationVerificationPassed,
  readLocalizationVerificationTransaction,
  validateTransactionAgainstManifest,
} = require('../lib/localization-verification-transaction');
const {
  validateLocalizationManifestShape,
} = require('../lib/localization-config');
const {
  parseArgs: parseManagerArgs,
} = require('../manage-localization-verification');
const { createTempProject, writeProjectFile } = require('./test-utils');

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
    },
    locales: ['en-US', 'ar-SA'],
    defaultLocale: 'en-US',
    translationMethod: 'agent',
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    generatedFiles: [],
    managedFiles: [],
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

function writeManifest(projectRoot, value) {
  writeProjectFile(
    projectRoot,
    '.powerpages-localization.json',
    `${JSON.stringify(value, null, 2)}\n`
  );
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
  markLocalizationVerificationPassed(projectRoot, transaction.runId);

  const failed = markLocalizationVerificationFailed(
    projectRoot,
    transaction.runId
  );

  assert.equal(failed.state, 'remediation-required');
  assert.equal(failed.verifiedAt, undefined);
  assert.throws(
    () => markLocalizationVerificationPassed(projectRoot, transaction.runId),
    /must be in-progress/
  );
});

test('blocks finalization while the rendered audit is active or abandoned', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  beginLocalizationVerificationAudit(projectRoot, transaction.runId);
  markLocalizationVerificationPassed(projectRoot, transaction.runId);

  assert.throws(
    () => finalizeLocalizationVerification(projectRoot),
    /still active or was abandoned/
  );

  abandonLocalizationVerificationAudit(projectRoot, transaction.runId);
  finalizeLocalizationVerification(projectRoot);
  assert.ok(!fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
});

test('allows only one rendered audit lease for a transaction', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  beginLocalizationVerificationAudit(projectRoot, transaction.runId);

  assert.throws(
    () => beginLocalizationVerificationAudit(projectRoot, transaction.runId),
    /already exists/
  );

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
});

test('finalizes a successful verification only after the manifest is ready', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  beginLocalizationVerification(projectRoot, ['ar-SA']);
  markLocalizationVerificationPassed(projectRoot);
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

test('finalizes failed verification only after fail-closed availability is restored', (t) => {
  const projectRoot = createTempProject(t);
  writeManifest(projectRoot, manifest());
  beginLocalizationVerification(projectRoot, ['ar-SA']);
  markLocalizationVerificationFailed(projectRoot);

  finalizeLocalizationVerification(projectRoot);

  assert.ok(!fs.existsSync(path.join(projectRoot, TRANSACTION_FILE)));
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
