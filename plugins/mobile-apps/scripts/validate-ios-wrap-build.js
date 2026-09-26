#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parsePlistStrings } = require('./validate-firebase-client-config');

const MODES = {
  development: { exportMethod: 'development', apnsEnvironment: 'development' },
  'ad-hoc': { exportMethod: 'ad-hoc', apnsEnvironment: 'production' },
};
const SIGNING_EXTENSIONS = new Set([
  '.cer',
  '.crt',
  '.der',
  '.key',
  '.mobileprovision',
  '.p12',
  '.p8',
  '.pem',
  '.pfx',
  '.provisionprofile',
]);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'build',
  'dist',
  'node_modules',
]);
const FORBIDDEN_WRAP_KEYS =
  /certificate|identity|keychain|password|private.?key|provision|signing.?secret/i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEAM_ID = /^[A-Z0-9]{10}$/;

class SafeError extends Error {}

function parseArgs(argv) {
  const result = { projectRoot: process.cwd(), mode: null, expectedTeamId: null };
  const names = {
    '--project-root': 'projectRoot',
    '--mode': 'mode',
    '--expected-team-id': 'expectedTeamId',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (!names[arg]) throw new SafeError(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new SafeError(`${arg} requires a value.`);
    result[names[arg]] = value;
    index += 1;
  }
  return result;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveSafeOutputPath(root, configuredPath = './dist') {
  if (typeof configuredPath !== 'string' || configuredPath.trim() === '') {
    throw new SafeError('outputPath must be a non-empty path.');
  }
  const requested = path.resolve(root, configuredPath);
  if (!isWithinRoot(requested, root)) {
    throw new SafeError('outputPath must remain inside the project root.');
  }

  // Lexical containment is not enough: `dist -> /outside` still makes
  // `dist/app.ipa` escape. Walk every existing component with lstat so no
  // project-local symlink can redirect either the build write or artifact scan.
  const relativeParts = path.relative(root, requested).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw new SafeError('outputPath could not be validated safely.');
    }
    if (stat.isSymbolicLink()) {
      throw new SafeError('outputPath must not contain symlinked path components.');
    }
  }

  let ancestor = requested;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realAncestor = fs.realpathSync(ancestor);
  if (!isWithinRoot(realAncestor, root)) {
    throw new SafeError('outputPath resolves outside the project root.');
  }
  if (fs.existsSync(requested) && !fs.lstatSync(requested).isDirectory()) {
    throw new SafeError('outputPath must be a directory.');
  }
  return requested;
}

function readJson(filePath, label) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new SafeError(`${label} is required.`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new SafeError(`${label} must contain valid JSON.`);
  }
}

function resolveProjectFile(root, configuredPath, label, { extension, required = true } = {}) {
  if (typeof configuredPath !== 'string' || configuredPath.trim() === '') {
    if (!required) return null;
    throw new SafeError(`${label} must be a non-empty project-relative path.`);
  }
  if (path.isAbsolute(configuredPath)) throw new SafeError(`${label} must be project-relative.`);
  const requested = path.resolve(root, configuredPath);
  if (!isWithinRoot(requested, root)) throw new SafeError(`${label} escapes the project root.`);
  if (!fs.existsSync(requested)) {
    if (!required) return requested;
    throw new SafeError(`${label} does not exist.`);
  }
  const stat = fs.lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SafeError(`${label} must be a regular, non-symlink file.`);
  }
  const resolved = fs.realpathSync(requested);
  if (!isWithinRoot(resolved, root)) throw new SafeError(`${label} resolves outside the project.`);
  if (extension && path.extname(resolved).toLowerCase() !== extension) {
    throw new SafeError(`${label} must be a ${extension} file.`);
  }
  return resolved;
}

function scanSigningMaterial(root) {
  const findings = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const extension = path.extname(entry.name).toLowerCase();
      if (SIGNING_EXTENSIONS.has(extension)) {
        findings.push(relative);
      }
    }
  }
  return findings.sort();
}

function inspectForbiddenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  const findings = [];
  for (const [key, child] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_WRAP_KEYS.test(key) && field !== 'ios.signing') findings.push(field);
    findings.push(...inspectForbiddenKeys(child, field));
  }
  return findings;
}

function evaluateExpoConfig(root, wrap, mode) {
  const configPath = path.join(root, 'app.config.js');
  if (!fs.existsSync(configPath)) throw new SafeError('app.config.js is required.');
  const previous = {};
  const values = {
    APP_DISPLAY_NAME: wrap.displayName,
    APP_ICON_PATH: wrap.iconPath,
    APP_VERSION: wrap.version,
    APP_VERSION_CODE: String(wrap.versionCode),
    APNS_ENVIRONMENT: MODES[mode].apnsEnvironment,
    DEV_CLIENT: mode === 'development' ? 'true' : 'false',
    IOS_BUNDLE_IDENTIFIER: wrap.bundleIdentifier,
  };
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  delete require.cache[require.resolve(configPath)];
  try {
    const exported = require(configPath);
    const config = typeof exported === 'function' ? exported({ config: {} }) : exported;
    if (!config || typeof config !== 'object') {
      throw new SafeError('app.config.js did not evaluate to an Expo config object.');
    }
    return config;
  } finally {
    delete require.cache[require.resolve(configPath)];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function validateWrapShape(wrap, mode, expectedTeamId) {
  const forbidden = inspectForbiddenKeys(wrap);
  if (forbidden.length > 0) {
    throw new SafeError(`wrap.config.json contains forbidden signing/secret fields: ${forbidden.join(', ')}.`);
  }
  if (wrap.ios?.simulator !== false) throw new SafeError('ios.simulator must be false.');
  if (wrap.ios?.signing?.exportMethod !== MODES[mode].exportMethod) {
    throw new SafeError(`ios.signing.exportMethod must be ${MODES[mode].exportMethod}.`);
  }
  const teamId = wrap.ios?.signing?.teamId;
  if (!TEAM_ID.test(teamId || '')) throw new SafeError('ios.signing.teamId must be a 10-character Apple Team ID.');
  if (expectedTeamId && teamId !== expectedTeamId) {
    throw new SafeError('Apple Team ID differs from the confirmed APNs handoff.');
  }
  if (!GUID.test(wrap.msal?.clientId || '') || !GUID.test(wrap.msal?.tenantId || '')) {
    throw new SafeError('wrap.config.json must contain GUID-shaped msal.clientId and msal.tenantId.');
  }
  if (!Number.isInteger(wrap.versionCode) || wrap.versionCode < 1) {
    throw new SafeError('versionCode must be a positive integer.');
  }
  if (typeof wrap.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(wrap.version)) {
    throw new SafeError('version must be a semantic version.');
  }
  if (typeof wrap.bundleIdentifier !== 'string' || !/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(wrap.bundleIdentifier)) {
    throw new SafeError('bundleIdentifier is invalid.');
  }
  if (typeof wrap.displayName !== 'string' || wrap.displayName.trim() === '') {
    throw new SafeError('displayName is required.');
  }
}

function validateProject(root, mode, expectedTeamId) {
  if (!MODES[mode]) throw new SafeError('--mode must be development or ad-hoc.');
  if (expectedTeamId && !TEAM_ID.test(expectedTeamId)) {
    throw new SafeError('--expected-team-id must be a 10-character Apple Team ID.');
  }
  const signingMaterial = scanSigningMaterial(root);
  if (signingMaterial.length > 0) {
    throw new SafeError(`signing material must be removed from the project: ${signingMaterial.join(', ')}.`);
  }

  const packageJson = readJson(path.join(root, 'package.json'), 'package.json');
  if (packageJson.scripts?.['build:ios'] !== 'wrap ios') {
    throw new SafeError('package.json build:ios must use the supported wrap ios command.');
  }
  const wrap = readJson(path.join(root, 'wrap.config.json'), 'wrap.config.json');
  validateWrapShape(wrap, mode, expectedTeamId);

  const auth = readJson(path.join(root, 'auth.config.json'), 'auth.config.json');
  if (auth.msal?.clientId !== wrap.msal.clientId || auth.msal?.tenantId !== wrap.msal.tenantId) {
    throw new SafeError('wrap.config.json MSAL identity differs from auth.config.json.');
  }

  const expo = evaluateExpoConfig(root, wrap, mode);
  if (expo.name !== wrap.displayName) throw new SafeError('evaluated Expo display name differs from wrap.config.json.');
  if (expo.version !== wrap.version) throw new SafeError('evaluated Expo version differs from wrap.config.json.');
  if (expo.icon !== wrap.iconPath) throw new SafeError('evaluated Expo icon differs from wrap.config.json.');
  if (expo.ios?.bundleIdentifier !== wrap.bundleIdentifier) {
    throw new SafeError('evaluated Expo iOS bundle identifier differs from wrap.config.json.');
  }
  if (expo.ios?.entitlements?.['aps-environment'] !== MODES[mode].apnsEnvironment) {
    throw new SafeError(`evaluated aps-environment must be ${MODES[mode].apnsEnvironment}.`);
  }

  const iconPath = resolveProjectFile(root, wrap.iconPath, 'iconPath', { extension: '.png' });
  const plistPath = resolveProjectFile(
    root,
    expo.ios?.googleServicesFile,
    'evaluated iOS Firebase plist',
  );
  const plist = parsePlistStrings(fs.readFileSync(plistPath));
  if (plist.identifier !== wrap.bundleIdentifier) {
    throw new SafeError('Firebase plist bundle ID differs from the evaluated Expo/wrap identity.');
  }

  const outputPath = resolveSafeOutputPath(root, wrap.outputPath || './dist');

  return {
    status: 'ready',
    mode,
    bundleIdentifier: wrap.bundleIdentifier,
    displayName: wrap.displayName,
    version: wrap.version,
    versionCode: wrap.versionCode,
    iconPath: path.relative(root, iconPath).split(path.sep).join('/'),
    clientId: wrap.msal.clientId,
    tenantId: wrap.msal.tenantId,
    firebaseProjectId: plist.projectId,
    firebaseIosAppId: plist.appId,
    firebasePlist: path.relative(root, plistPath).split(path.sep).join('/'),
    appleTeamId: wrap.ios.signing.teamId,
    exportMethod: MODES[mode].exportMethod,
    apnsEnvironment: MODES[mode].apnsEnvironment,
    outputPath: path.relative(root, outputPath).split(path.sep).join('/') || '.',
    bundleStep: packageJson.scripts?.['bundle:ios'] || null,
  };
}

function usage() {
  return [
    'Usage: node validate-ios-wrap-build.js --project-root <path>',
    '  --mode <development|ad-hoc> --expected-team-id <APPLE_TEAM_ID>',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const requestedRoot = path.resolve(args.projectRoot);
    if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) {
      throw new SafeError('Project root does not exist.');
    }
    const result = validateProject(fs.realpathSync(requestedRoot), args.mode, args.expectedTeamId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof SafeError ? error.message : 'Unable to validate the iOS wrapped build.';
    process.stderr.write(`BLOCKED: ${message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  evaluateExpoConfig,
  inspectForbiddenKeys,
  isWithinRoot,
  main,
  parseArgs,
  resolveSafeOutputPath,
  scanSigningMaterial,
  validateProject,
  validateWrapShape,
};
