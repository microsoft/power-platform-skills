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
]);
const PATH_ARGUMENTS = new Set([
  'projectRoot',
  'specPath',
  'evidenceDir',
  'output',
]);
const USAGE =
  'Usage: audit-rendered-bidirectional-readiness.js --url <base-url> ' +
  '--projectRoot <path> (--spec <json-file> | --spec-inline <json>) ' +
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
  if (!parsed.url || !parsed.projectRoot ||
      (!parsed.specPath && !parsed.specInline) ||
      (parsed.specPath && parsed.specInline)) {
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
      markLocalizationVerificationPassed(args.projectRoot, transaction.runId);
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
