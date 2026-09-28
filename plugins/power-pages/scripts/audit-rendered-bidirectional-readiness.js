#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { detectBrowserLaunchOptions } = require('./lib/detect-browser');
const {
  MANIFEST_NAME,
  validateLocalizationManifestShape,
} = require('./lib/localization-config');
const {
  runRenderedBidirectionalAudit,
} = require('./lib/rendered-bidirectional-readiness');
const {
  resolveVerificationProfile,
} = require('./lib/localization-verification-profile');
const {
  computeVerificationInputFingerprint,
  createVerificationEvidence,
  validateReusableVerificationReport,
} = require('./lib/verification-evidence');
const {
  beginLocalizationVerificationAudit,
  endLocalizationVerificationAudit,
  markLocalizationVerificationFailed,
  markLocalizationVerificationPassed,
  readLocalizationVerificationTransaction,
  validateTransactionAgainstManifest,
} = require('./lib/localization-verification-transaction');

const recoveryContext = {
  projectRoot: null,
  transactionRead: false,
  runId: null,
};

const ARGUMENTS = new Map([
  ['--url', 'url'],
  ['--projectRoot', 'projectRoot'],
  ['--spec', 'specPath'],
  ['--spec-inline', 'specInline'],
  ['--evidence-dir', 'evidenceDir'],
  ['--output', 'output'],
  ['--reuse-report', 'reuseReport'],
]);
const PATH_ARGUMENTS = new Set([
  'projectRoot',
  'specPath',
  'evidenceDir',
  'output',
  'reuseReport',
]);
const USAGE =
  'Usage: audit-rendered-bidirectional-readiness.js --projectRoot <path> ' +
  '((--url <base-url> (--spec <json-file> | --spec-inline <json>)) | ' +
  '--reuse-report <report-json>) ' +
  '[--evidence-dir <path>] [--output <report-json>]';

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const property = ARGUMENTS.get(arg);
    if (!property) {
      throw new Error(`Unknown or misplaced argument "${arg}".\n${USAGE}`);
    }
    if (Object.hasOwn(parsed, property)) {
      throw new Error(`Argument "${arg}" may be specified only once.\n${USAGE}`);
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new Error(`Argument "${arg}" requires a value.\n${USAGE}`);
    }
    parsed[property] = PATH_ARGUMENTS.has(property)
      ? path.resolve(value)
      : value;
    index += 1;
  }
  const specCount = Number(Boolean(parsed.specPath)) +
    Number(Boolean(parsed.specInline));
  if (!parsed.projectRoot ||
      (!parsed.reuseReport && !parsed.url) ||
      (parsed.reuseReport ? specCount !== 0 : specCount !== 1)) {
    throw new Error(USAGE);
  }
  return parsed;
}

function findProjectRootArg(argv) {
  const candidates = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--projectRoot') continue;
    const value = argv[index + 1];
    if (typeof value === 'string' && value.trim() &&
        !value.startsWith('--')) {
      candidates.add(path.resolve(value));
    }
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

function loadPlaywright(projectRoot) {
  const modulePaths = [
    'playwright',
    path.join(projectRoot, 'node_modules', 'playwright'),
    'playwright-core',
    path.join(projectRoot, 'node_modules', 'playwright-core'),
  ];
  for (const modulePath of modulePaths) {
    try {
      return require(modulePath);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('playwright not found. Run: npm install --save-dev playwright');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  recoveryContext.projectRoot = args.projectRoot;
  if (args.reuseReport) {
    const report = JSON.parse(fs.readFileSync(args.reuseReport, 'utf8'));
    const reuseErrors = validateReusableVerificationReport(
      args.projectRoot,
      report
    );
    if (reuseErrors.length > 0) {
      throw new Error(`Rendered verification evidence cannot be reused:\n- ${
        reuseErrors.join('\n- ')
      }`);
    }
    report.verification = {
      ...report.verification,
      reused: true,
      reusedAt: new Date().toISOString(),
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) {
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      fs.writeFileSync(args.output, json);
    }
    process.stdout.write(json);
    return;
  }
  const spec = JSON.parse(
    args.specInline ?? fs.readFileSync(args.specPath, 'utf8')
  );
  const manifestPath = path.join(args.projectRoot, MANIFEST_NAME);
  const transactionResult =
    readLocalizationVerificationTransaction(args.projectRoot);
  if (transactionResult.errors.length > 0) {
    throw new Error(transactionResult.errors.join('\n'));
  }
  const transaction = transactionResult.transaction;
  recoveryContext.transactionRead = true;
  recoveryContext.runId = transaction?.runId || null;
  let manifest = null;
  let localizationContext = null;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifestErrors = validateLocalizationManifestShape(manifest, {
      verificationLocales: transaction?.targetLocales || [],
    });
    if (manifestErrors.length > 0) {
      throw new Error(
        `${MANIFEST_NAME} is invalid:\n- ${manifestErrors.join('\n- ')}`
      );
    }
    if (transaction) {
      if (resolveVerificationProfile(spec) !==
          (transaction.verificationProfile || 'extensive')) {
        throw new Error(
          'Rendered run specification profile must match the active localization transaction.'
        );
      }
      const transactionErrors = validateTransactionAgainstManifest(
        transaction,
        manifest,
        { requireExposed: true }
      );
      if (transactionErrors.length > 0) {
        throw new Error(transactionErrors.join('\n'));
      }
      if (!isLoopbackUrl(args.url)) {
        throw new Error(
          'In-progress locale verification must use a loopback development URL.'
        );
      }
    }
    localizationContext = {
      locales: manifest.locales,
      defaultLocale: manifest.defaultLocale,
      mode: manifest.mode,
      unavailableLocales: Array.isArray(manifest.unavailableLocales)
        ? manifest.unavailableLocales
        : [],
      verificationLocales: transaction?.targetLocales || [],
    };
  } else if (spec.runtimeSwitching === true) {
    throw new Error(
      `${MANIFEST_NAME} is required when runtimeSwitching is enabled.`
    );
  }
  let auditLeaseStarted = false;
  const inputFingerprint = computeVerificationInputFingerprint(args.projectRoot);
  try {
    if (transaction) {
      beginLocalizationVerificationAudit(
        args.projectRoot,
        transaction.runId
      );
      auditLeaseStarted = true;
    }
    const { chromium } = loadPlaywright(args.projectRoot);
    const result = await runRenderedBidirectionalAudit({
      url: args.url,
      spec,
      chromium,
      localizationContext,
      browserLaunchOptions: detectBrowserLaunchOptions(),
      evidenceDir: args.evidenceDir,
    });
    const completedFingerprint =
      computeVerificationInputFingerprint(args.projectRoot);
    if (completedFingerprint !== inputFingerprint) {
      throw new Error(
        'Project verification inputs changed while the rendered audit was running.'
      );
    }
    result.verification.evidence = createVerificationEvidence(
      args.projectRoot,
      spec
    );
    if (transaction && result.summary.errors > 0) {
      markLocalizationVerificationFailed(args.projectRoot, transaction.runId);
    }
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (args.output) {
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      fs.writeFileSync(args.output, json);
    }
    process.stdout.write(json);
    if (transaction && result.summary.errors === 0) {
      markLocalizationVerificationPassed(
        args.projectRoot,
        transaction.runId,
        result.verification
      );
    }
    process.exitCode = result.summary.errors > 0 ? 1 : 0;
  } catch (error) {
    if (transaction) {
      try {
        markLocalizationVerificationFailed(args.projectRoot, transaction.runId);
      } catch (transactionError) {
        transactionError.message += `\nThe audit also failed: ${error.message}`;
        throw transactionError;
      }
    }
    throw error;
  } finally {
    if (auditLeaseStarted) {
      endLocalizationVerificationAudit(args.projectRoot, transaction.runId);
    }
  }
}

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]';
  } catch {
    return false;
  }
}

if (require.main === module) {
  main().catch((error) => {
    try {
      const projectRoot = recoveryContext.projectRoot ||
        findProjectRootArg(process.argv.slice(2));
      if (!projectRoot) throw new Error('projectRoot is unavailable.');
      if (recoveryContext.transactionRead) {
        if (recoveryContext.runId) {
          markLocalizationVerificationFailed(
            projectRoot,
            recoveryContext.runId
          );
        }
      } else {
        const { transaction, errors } =
          readLocalizationVerificationTransaction(projectRoot);
        if (errors.length === 0 && transaction?.state === 'in-progress') {
          markLocalizationVerificationFailed(projectRoot, transaction.runId);
        }
      }
    } catch {
      // Preserve the original audit/setup error; the transaction remains as a
      // deployment blocker if it could not be moved to remediation-required.
    }
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  findProjectRootArg,
  isLoopbackUrl,
  loadPlaywright,
  parseArgs,
};
