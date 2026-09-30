#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodeProcess = require('node:process');
const { parseArgs, validateFlags, emitResult } = require('./lib/dataverse-auth.js');
const { runPac } = require('./lib/pac-exec.js');
const { validatePublisherPrefix, validateSolutionUniqueName, validateNamespace, validateControlName, orgControlName } = require('./lib/pcf-names.js');
const { findControlProject } = require('./lib/pcf-build.js');
const { pcfprojBuildMode } = require('./lib/pcf-doctor.js');
const { makePcfSdk, findCustomControl, solutionPrefix } = require('./lib/pcf-dataverse.js');
const { parseManifest } = require('./lib/pcf-manifest.js');

const USAGE = `Usage:
  node scripts/pcf-push.js --project <dir> --env <url> (--solution <uniqueName> | --publisher-prefix <p>) [--incremental] [--verbosity minimal|normal|detailed|diagnostic] [--allow-dev-bundle] [--no-verify]

Deploys with pac pcf push and publishes all pending customizations in the target environment. The skill must obtain consent before running this script; this script never prompts.`;

const KNOWN = ['project', 'env', 'solution', 'publisher-prefix', 'incremental', 'verbosity', 'allow-dev-bundle', 'no-verify'];
const NEED_VALUE = ['project', 'env', 'solution', 'publisher-prefix', 'verbosity'];
const VERBOSITIES = new Set(['minimal', 'normal', 'detailed', 'diagnostic']);
const PUSH_TIMEOUT_MS = 15 * 60 * 1000;

const HINTS = [
  {
    // Observed text: "Missing required tool dotnet".
    match: 'Missing required tool',
    hint: 'Install or update the missing tool reported by pac, then retry the push.',
  },
  {
    // Observed text: "... was not found in the directory ...".
    match: 'was not found in the directory',
    hint: 'Run from the PCF project root, pass --project <dir>, and confirm package restore/build outputs exist.',
  },
  {
    // Observed text: "Could not find solution with unique name <name>".
    match: 'Could not find solution with unique name',
    hint: 'Create the unmanaged solution first or pass its exact unique name to --solution.',
  },
  {
    // Observed text: "Solution <name> is managed".
    match: 'is managed',
    hint: 'pac pcf push requires an unmanaged target. Choose an unmanaged solution or publisher prefix.',
  },
  {
    // Observed text: "... but is Managed".
    match: 'but is Managed',
    hint: 'The target solution/control is managed. Push to an unmanaged layer that you own.',
  },
  {
    // Observed text: "platform library fluent_9_68_0 with version 9.68.0 is not supported by the platform.".
    match: 'is not supported by the platform',
    hint: 'The target platform rejected a platform-library version. Run pcf-doctor.js and pcf-upgrade.js --apply --steps PLATFORM_LIB_VERSION, then see references/pcf-troubleshooting.md.',
  },
];

function usageError(message) {
  process.stderr.write(`${USAGE}\n${message}\n`);
  process.exit(1);
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const flagError = validateFlags(argv, {
    known: KNOWN,
    needValue: NEED_VALUE,
    hints: {
      project: 'path to a PCF project directory',
      env: 'absolute https:// Dataverse environment origin, for example https://contoso.crm.dynamics.com',
      verbosity: 'one of: minimal, normal, detailed, diagnostic',
    },
  });
  if (flagError) usageError(flagError);

  const flags = parsed.flags;
  if (!flags.project) usageError('--project is required');
  if (!flags.env) usageError('--env is required');
  const hasSolution = flags.solution !== undefined;
  const hasPrefix = flags['publisher-prefix'] !== undefined;
  if (hasSolution === hasPrefix) usageError('exactly one of --solution or --publisher-prefix is required');

  const envOrigin = normalizeEnvOrigin(flags.env);
  const verbosity = flags.verbosity ? String(flags.verbosity) : 'minimal';
  if (!VERBOSITIES.has(verbosity)) usageError(`--verbosity must be one of: ${[...VERBOSITIES].join(', ')}`);

  if (hasPrefix) {
    const prefixError = validatePublisherPrefix(String(flags['publisher-prefix']));
    if (prefixError) usageError(prefixError);
  } else {
    const solutionError = validateSolutionUniqueName(String(flags.solution));
    if (solutionError) usageError(solutionError);
  }

  const found = findControlProject(path.resolve(String(flags.project)));
  if (found.error) usageError(found.error);
  const projectDir = found.projectDir;
  const pcfprojText = fs.readFileSync(found.pcfproj, 'utf8');
  // `pac pcf push` builds Debug, and Microsoft documents that development PCF bundles should not be
  // deployed to Dataverse because they can violate solution-checker rules such as dynamic `eval`.
  // The doctor owns the offset-sensitive MSBuild detection so this deploy wrapper cannot drift from
  // the repair guidance.
  // See: https://learn.microsoft.com/power-apps/developer/component-framework/code-components-best-practices#avoid-deploying-development-builds-to-dataverse
  const buildMode = pcfprojBuildMode(pcfprojText);
  if (!flags['allow-dev-bundle'] && buildMode.status !== 'production') {
    usageError(buildModeError(buildMode));
  }

  const manifest = readSingleManifest(found.manifests);
  validateControlIdentity(manifest.model.control);

  const selectorArgs = hasSolution
    ? ['--solution-unique-name', String(flags.solution)]
    : ['--publisher-prefix', String(flags['publisher-prefix'])];
  const pacArgs = [
    'pcf', 'push',
    '--environment', envOrigin,
    ...selectorArgs,
    ...(flags.incremental ? ['--incremental'] : []),
    '--verbosity', verbosity,
  ];

  const push = runPac(pacArgs, { cwd: projectDir, timeoutMs: PUSH_TIMEOUT_MS });
  if (timedOut(push)) {
    // On Windows, process-runner starts a pac.cmd batch shim under checked cmd.exe arguments. Killing
    // that wrapper on timeout is best-effort and may leave the MSBuild child running, so report the
    // diagnostic log path and never claim the push was aborted.
    return emitResult(false, {
      ok: false,
      stage: 'push',
      timedOut: true,
      log: buildLogPath(projectDir),
      message: 'pac pcf push timed out; the push or its MSBuild child may still be running. Inspect the build log before retrying.',
    });
  }

  if ((push.status || 0) !== 0) {
    return emitResult(false, {
      ok: false,
      stage: 'push',
      status: push.status,
      hints: pushHints(push),
      logTail: readBuildLogTail(projectDir),
      stdout: scrubbedTail(push.stdout, 60),
      stderr: scrubbedTail(push.stderr, 60),
    });
  }

  const expectedVersion = manifest.model.control.version || null;
  let registered = { ok: false, reason: 'not verified' };
  if (!flags['no-verify']) {
    registered = await readRegistration({ envOrigin, projectDir, solution: flags.solution, publisherPrefix: flags['publisher-prefix'], manifest });
  }

  const knownPrefix = flags['publisher-prefix'] ? String(flags['publisher-prefix']) : registered.prefix;
  const controlName = knownPrefix
    ? orgControlName(knownPrefix, manifest.model.control.namespace, manifest.model.control.constructor)
    : `${manifest.model.control.namespace}.${manifest.model.control.constructor}`;
  let receipt;
  try {
    receipt = writeReceipt(projectDir, {
      envOrigin,
      control: controlName,
      version: expectedVersion,
      solution: flags.solution ? String(flags.solution) : undefined,
      publisherPrefix: flags['publisher-prefix'] ? String(flags['publisher-prefix']) : undefined,
      incremental: !!flags.incremental,
      registered,
    });
  } catch (err) {
    return emitResult(false, {
      ok: false,
      stage: 'receipt',
      reason: errorReason(err),
      registered: stripPrivateRegistration(registered),
    });
  }

  const ok = !!registered.ok || !!flags['no-verify'];
  return emitResult(ok, {
    ok,
    stage: 'done',
    control: controlName,
    version: expectedVersion,
    registered: stripPrivateRegistration(registered),
    receipt,
  });
}

function normalizeEnvOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
      throw new Error('bad env');
    }
    return url.origin;
  } catch {
    usageError('--env must be an absolute https:// Dataverse environment origin with no path, query, or fragment (for example https://contoso.crm.dynamics.com)');
  }
}

function buildModeError(mode) {
  const base = 'Refusing to run pac pcf push because Debug builds otherwise ship a development bundle that fails the solution checker eval rule.';
  if (mode.status === 'ineffective' && mode.reason === 'conditioned') {
    return `${base} PcfBuildMode is set but ineffective — pac pcf push builds Debug, so make the production setting unconditional below the Microsoft.Common.props import.`;
  }
  if (mode.status === 'ineffective') {
    return `${base} PcfBuildMode is set but ineffective — move it below the Microsoft.Common.props import.`;
  }
  if (mode.status === 'missing') {
    return `${base} Add <PcfBuildMode>production</PcfBuildMode> after the Microsoft.Common.props import, or pass --allow-dev-bundle intentionally.`;
  }
  return `${base} PcfBuildMode is '${mode.value || mode.status}', not production; set it to production after the Microsoft.Common.props import, or pass --allow-dev-bundle intentionally.`;
}

function readSingleManifest(manifests) {
  const manifestPath = Array.isArray(manifests) && manifests[0];
  if (!manifestPath) usageError('No ControlManifest.Input.xml file was found in the PCF project.');
  const parsed = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
  if (parsed.errors && parsed.errors.length) usageError(parsed.errors.map((item) => item.message || item.code).join('\n'));
  return parsed;
}

function validateControlIdentity(control) {
  const namespaceError = validateNamespace(control.namespace, control.constructor);
  if (namespaceError) usageError(namespaceError);
  const controlError = validateControlName(control.constructor, control.namespace);
  if (controlError) usageError(controlError);
}

function timedOut(result) {
  return !!(result && result.error && result.error.code === 'ETIMEDOUT');
}

function pushHints(result) {
  const text = [result && result.stdout, result && result.stderr].filter(Boolean).join('\n');
  const hints = [];
  for (const entry of HINTS) {
    if (text.includes(entry.match) && !hints.includes(entry.hint)) hints.push(entry.hint);
  }
  if (hints.length === 0) hints.push('Review the pac pcf push output and obj/pcf-push-build.log for the failing MSBuild or Dataverse step.');
  return hints;
}

function buildLogPath(projectDir) {
  return path.join(projectDir, 'obj', 'pcf-push-build.log');
}

function readBuildLogTail(projectDir) {
  const file = buildLogPath(projectDir);
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return lines.slice(-40).map(scrubSecrets);
  } catch {
    return [];
  }
}

function scrubbedTail(text, maxLines) {
  return String(text || '')
    .split(/\r?\n/)
    .map(scrubSecrets)
    .slice(-maxLines);
}

function scrubSecrets(line) {
  const key = '(?:access_token|refresh_token|id_token|client_secret|clientSecret|password|pwd|sig|authorization|authorization_code|device_code)';
  const keyValue = new RegExp(`(\\b${key}\\b\\s*=\\s*)[^\\s&;,]+`, 'gi');
  const keyColon = new RegExp('(\\b(?:access_token|refresh_token|id_token|client_secret|clientSecret|password|pwd|sig|authorization_code|device_code)\\b\\s*:\\s*)[^\\s,;]+', 'gi');
  const quotedJson = new RegExp(`(["'])(${key})(\\1\\s*:\\s*)(["'])[^"']*\\4`, 'gi');
  const authValue = /\bauthorization\b(\s*[:=]\s*)(?!Bearer\b)[^\s&;,]+/gi;
  return String(line || '')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-jwt>')
    .replace(/\bhttps?:\/\/[^\s"'<>),;]+/gi, redactUrl)
    .replace(/\b(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1<redacted>')
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1<redacted>')
    .replace(quotedJson, '$1$2$3$4<redacted>$4')
    .replace(keyValue, '$1<redacted>')
    .replace(keyColon, '$1<redacted>')
    .replace(authValue, 'authorization$1<redacted>');
}

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return 'https://<redacted>/…';
  }
}

function errorReason(err) {
  return err && err.message ? String(err.message) : String(err);
}

async function readRegistration({ envOrigin, projectDir, solution, publisherPrefix, manifest }) {
  try {
    const sdk = await makePcfSdk(envOrigin, path.join(projectDir, '.maker-workspace', 'pcf-push'));
    const prefix = publisherPrefix ? String(publisherPrefix) : await solutionPrefix(sdk, String(solution));
    const expectedName = orgControlName(prefix, manifest.model.control.namespace, manifest.model.control.constructor);
    const expectedVersion = manifest.model.control.version || null;
    const row = await findCustomControl(sdk, expectedName);
    if (!row) return { ok: false, version: null, expected: expectedVersion, reason: scrubSecrets(`Custom control '${expectedName}' was not found after push.`), prefix };
    const ok = !expectedVersion || row.version === expectedVersion;
    return {
      ok,
      version: row.version || null,
      expected: expectedVersion,
      ...(ok ? {} : { reason: scrubSecrets('Registered version does not match the manifest; Dataverse caching or the push/publish may not have taken effect yet.') }),
      prefix,
    };
  } catch (err) {
    return { ok: false, reason: scrubSecrets(err && err.message ? String(err.message) : String(err)) };
  }
}

function stripPrivateRegistration(registered) {
  const copy = sanitizeRegistration(registered);
  delete copy.prefix;
  return copy;
}

function sanitizeRegistration(registered) {
  const clean = {};
  for (const [key, value] of Object.entries(registered || {})) {
    if (['ok', 'version', 'expected', 'componentState', 'reason', 'prefix'].includes(key)) {
      clean[key] = typeof value === 'string' ? scrubSecrets(value) : value;
    }
  }
  return clean;
}

function writeReceipt(projectDir, data) {
  const receiptPath = path.join(projectDir, 'pcf-receipt.json');
  const tempPath = path.join(projectDir, `.pcf-receipt-${nodeProcess.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const receipt = {
    schemaVersion: 1,
    pushedAt: new Date().toISOString(),
    envOrigin: data.envOrigin,
    control: data.control,
    version: data.version,
    ...(data.solution ? { solution: data.solution } : { publisherPrefix: data.publisherPrefix }),
    incremental: data.incremental,
    tool: {
      pac: 'pac pcf push',
      node: nodeProcess.version,
    },
    registered: stripPrivateRegistration(data.registered),
  };
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, receiptPath);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best-effort cleanup after a failed receipt write */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* the temp may not have been created yet */ }
    throw err;
  }
  return receiptPath;
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}

module.exports = { main };
