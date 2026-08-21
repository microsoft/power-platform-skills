#!/usr/bin/env node

'use strict';

// Validates Firebase's native client SDK files without invoking Firebase or parsing
// executable project config. It also compares a freshly downloaded candidate with the
// canonical project-local file so workflows never let `apps:sdkconfig --out` silently
// overwrite a different environment's configuration.

const fs = require('node:fs');
const path = require('node:path');

const MAX_CONFIG_BYTES = 1024 * 1024;
const REQUIRED_ARGS = [
  'platform',
  'candidate',
  'destination',
  'expectedProjectId',
  'expectedAppId',
  'expectedIdentifier',
];

class SafeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function issue(code, field, message) {
  return { code, field, message };
}

function parseArgs(argv, cwd = process.cwd()) {
  const parsed = {
    projectRoot: cwd,
    platform: null,
    candidate: null,
    destination: null,
    expectedProjectId: null,
    expectedAppId: null,
    expectedIdentifier: null,
    help: false,
  };
  const names = {
    '--project-root': 'projectRoot',
    '--platform': 'platform',
    '--candidate': 'candidate',
    '--destination': 'destination',
    '--expected-project-id': 'expectedProjectId',
    '--expected-app-id': 'expectedAppId',
    '--expected-identifier': 'expectedIdentifier',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    const name = names[arg];
    if (!name) throw new SafeError('unknown-argument', `Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new SafeError('missing-argument-value', `${arg} requires a value.`);
    }
    parsed[name] = value;
    index += 1;
  }

  if (!parsed.help) {
    for (const name of REQUIRED_ARGS) {
      if (!parsed[name]) throw new SafeError('missing-required-argument', `Missing ${name}.`);
    }
    parsed.platform = parsed.platform.toLowerCase();
    if (!['android', 'ios'].includes(parsed.platform)) {
      throw new SafeError('unsupported-platform', '--platform must be android or ios.');
    }
  }
  return parsed;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveProjectRoot(projectRootArg) {
  const requested = path.resolve(projectRootArg);
  let stat;
  try {
    stat = fs.statSync(requested);
  } catch {
    throw new SafeError('project-root-not-found', 'Project root does not exist.');
  }
  if (!stat.isDirectory()) {
    throw new SafeError('project-root-not-directory', 'Project root must be a directory.');
  }
  return fs.realpathSync(requested);
}

function resolveProjectFile(projectRoot, fileArg, { mustExist }) {
  const requested = path.resolve(projectRoot, fileArg);
  if (!isWithinRoot(requested, projectRoot)) {
    throw new SafeError('file-outside-project-root', 'Config file must be inside project root.');
  }

  const parent = path.dirname(requested);
  let realParent;
  try {
    realParent = fs.realpathSync(parent);
  } catch {
    throw new SafeError('parent-not-found', 'Config file parent directory does not exist.');
  }
  if (!isWithinRoot(realParent, projectRoot)) {
    throw new SafeError('file-outside-project-root', 'Config file must be inside project root.');
  }

  let stat;
  try {
    stat = fs.lstatSync(requested);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (mustExist) throw new SafeError('file-not-found', 'Config file does not exist.');
    return requested;
  }
  if (stat.isSymbolicLink()) {
    throw new SafeError('file-symbolic-link', 'Config file must not be a symbolic link.');
  }
  if (!stat.isFile()) throw new SafeError('file-not-regular', 'Config path must be a regular file.');
  const resolved = fs.realpathSync(requested);
  if (!isWithinRoot(resolved, projectRoot)) {
    throw new SafeError('file-outside-project-root', 'Config file must be inside project root.');
  }
  return resolved;
}

function readConfig(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new SafeError('file-too-large', `Config file exceeds ${MAX_CONFIG_BYTES} bytes.`);
  }
  return fs.readFileSync(filePath);
}

function hasAdminCredentialShape(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value)) {
    const keys = new Set(Object.keys(value));
    if (
      value.type === 'service_account'
      || keys.has('private_key')
      || (keys.has('private_key_id') && keys.has('client_email'))
    ) {
      return true;
    }
  }
  return Object.values(value).some((child) => hasAdminCredentialShape(child, seen));
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new SafeError('invalid-json', 'Android client config is not valid JSON.');
  }
}

function parseAndroidClientIdentities(buffer) {
  const config = parseJson(buffer);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new SafeError('config-not-object', 'Android client config must be a JSON object.');
  }
  if (hasAdminCredentialShape(config)) {
    throw new SafeError(
      'admin-service-account-forbidden',
      'Firebase Admin service-account JSON is forbidden; use only apps:sdkconfig client output.',
    );
  }
  if (!Array.isArray(config.client)) {
    throw new SafeError('clients-missing', 'Android client config has no client array.');
  }
  return {
    projectId: typeof config.project_info?.project_id === 'string'
      ? config.project_info.project_id
      : null,
    clients: config.client.map((client) => ({
      appId: typeof client?.client_info?.mobilesdk_app_id === 'string'
        ? client.client_info.mobilesdk_app_id
        : null,
      identifier: typeof client?.client_info?.android_client_info?.package_name === 'string'
        ? client.client_info.android_client_info.package_name
        : null,
    })),
  };
}

function validateAndroidConfig(buffer, expected) {
  let identity;
  try {
    identity = parseAndroidClientIdentities(buffer);
  } catch (error) {
    if (error instanceof SafeError) return [issue(error.code, 'config', error.message)];
    throw error;
  }

  const issues = [];
  if (identity.projectId !== expected.projectId) {
    issues.push(issue('project-id-mismatch', 'project_info.project_id', 'Firebase project ID does not match.'));
  }

  // google-services.json stores identity on the same client record:
  // client_info.mobilesdk_app_id + client_info.android_client_info.package_name.
  // Requiring one record to match both prevents accepting an app ID from one package
  // and a package name from another client in a multi-app Firebase project.
  const matches = identity.clients.filter((client) => (
    client.appId === expected.appId
    && client.identifier === expected.identifier
  ));
  if (matches.length === 0) {
    issues.push(issue(
      'android-app-identity-mismatch',
      'client[].client_info',
      'No Android client record matches both expected app ID and package name.',
    ));
  } else if (matches.length > 1) {
    issues.push(issue(
      'android-app-identity-ambiguous',
      'client[].client_info',
      'Multiple Android client records match the expected app identity.',
    ));
  }
  return issues;
}

function decodeXmlText(value) {
  if (value.includes('<')) throw new SafeError('plist-value-invalid', 'Plist string contains markup.');
  return value.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (entity, body) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const radix = body.startsWith('#x') ? 16 : 10;
    const digits = body.startsWith('#x') ? body.slice(2) : body.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    if (!Number.isSafeInteger(codePoint) || codePoint > 0x10FFFF) {
      throw new SafeError('plist-entity-invalid', 'Plist contains an invalid numeric entity.');
    }
    return String.fromCodePoint(codePoint);
  }).replace(/&[^;]*;/g, () => {
    throw new SafeError('plist-entity-unsupported', 'Plist contains an unsupported entity.');
  }).trim();
}

function extractPlistString(xml, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyPattern = new RegExp(`<key>\\s*${escapedKey}\\s*</key>`, 'g');
  const keyMatches = [...xml.matchAll(keyPattern)];
  if (keyMatches.length !== 1) {
    throw new SafeError(
      keyMatches.length === 0 ? 'plist-key-missing' : 'plist-key-duplicate',
      `Plist must contain exactly one ${key} key.`,
    );
  }
  const valuePattern = new RegExp(
    `<key>\\s*${escapedKey}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`,
  );
  const valueMatch = xml.match(valuePattern);
  if (!valueMatch) throw new SafeError('plist-value-missing', `Plist ${key} must have a string value.`);
  return decodeXmlText(valueMatch[1]);
}

function parsePlistStrings(buffer) {
  const xml = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const applePlistDoctype =
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
  const doctypes = xml.match(/<!DOCTYPE[\s\S]*?>/gi) ?? [];

  // Firebase emits Apple's canonical plist declaration. Allow that exact inert
  // declaration, but reject custom DTDs, internal subsets, and entity declarations.
  // This parser extracts scalar values directly and never resolves the external URL.
  if (
    /<!ENTITY/i.test(xml) ||
    doctypes.length > 1 ||
    (doctypes.length === 1 && doctypes[0] !== applePlistDoctype)
  ) {
    throw new SafeError(
      'plist-declaration-forbidden',
      'Plist contains a custom DTD or entity declaration.',
    );
  }
  if (!/<plist(?:\s+version="1\.0")?\s*>[\s\S]*<dict>[\s\S]*<\/dict>[\s\S]*<\/plist>\s*$/i.test(xml)) {
    throw new SafeError('plist-shape-invalid', 'iOS client config is not a supported plist dictionary.');
  }
  return {
    projectId: extractPlistString(xml, 'PROJECT_ID'),
    appId: extractPlistString(xml, 'GOOGLE_APP_ID'),
    identifier: extractPlistString(xml, 'BUNDLE_ID'),
  };
}

function validateIosConfig(buffer, expected) {
  let actual;
  try {
    actual = parsePlistStrings(buffer);
  } catch (error) {
    if (error instanceof SafeError) return [issue(error.code, 'plist', error.message)];
    throw error;
  }
  const issues = [];
  if (actual.projectId !== expected.projectId) {
    issues.push(issue('project-id-mismatch', 'PROJECT_ID', 'Firebase project ID does not match.'));
  }
  if (actual.appId !== expected.appId) {
    issues.push(issue('ios-app-id-mismatch', 'GOOGLE_APP_ID', 'Firebase iOS app ID does not match.'));
  }
  if (actual.identifier !== expected.identifier) {
    issues.push(issue('ios-bundle-id-mismatch', 'BUNDLE_ID', 'iOS bundle ID does not match.'));
  }
  return issues;
}

function validateConfig(platform, buffer, expected) {
  return platform === 'android'
    ? validateAndroidConfig(buffer, expected)
    : validateIosConfig(buffer, expected);
}

function inspectFiles({
  platform,
  candidatePath,
  destinationPath,
  expected,
}) {
  const candidate = readConfig(candidatePath);
  const candidateIssues = validateConfig(platform, candidate, expected);
  if (candidateIssues.length > 0) {
    return { status: 'invalid', candidateIssues, existingIssues: [] };
  }
  if (!fs.existsSync(destinationPath)) {
    return { status: 'ready', candidateIssues: [], existingIssues: [] };
  }

  const existing = readConfig(destinationPath);
  const existingIssues = validateConfig(platform, existing, expected);
  if (existingIssues.length > 0) {
    return {
      status: 'conflict',
      reason: 'existing-config-invalid',
      candidateIssues: [],
      existingIssues,
    };
  }
  if (candidate.equals(existing)) {
    return { status: 'reuse', candidateIssues: [], existingIssues: [] };
  }
  return {
    status: 'conflict',
    reason: 'existing-content-differs',
    candidateIssues: [],
    existingIssues: [],
  };
}

function usage() {
  return [
    'Usage: node validate-firebase-client-config.js --project-root <path>',
    '  --platform <android|ios> --candidate <path> --destination <path>',
    '  --expected-project-id <id> --expected-app-id <id> --expected-identifier <id>',
    '',
    'Both paths must be project-local. The destination may not exist yet.',
  ].join('\n');
}

function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  try {
    const args = parseArgs(argv, cwd);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const projectRoot = resolveProjectRoot(args.projectRoot);
    const candidatePath = resolveProjectFile(projectRoot, args.candidate, { mustExist: true });
    const destinationPath = resolveProjectFile(projectRoot, args.destination, { mustExist: false });
    if (candidatePath === destinationPath) {
      throw new SafeError('paths-must-differ', 'Candidate and destination paths must differ.');
    }
    const expected = {
      projectId: args.expectedProjectId,
      appId: args.expectedAppId,
      identifier: args.expectedIdentifier,
    };
    const result = inspectFiles({
      platform: args.platform,
      candidatePath,
      destinationPath,
      expected,
    });
    result.platform = args.platform;
    result.candidate = path.relative(projectRoot, candidatePath).split(path.sep).join('/');
    result.destination = path.relative(projectRoot, destinationPath).split(path.sep).join('/');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return ['ready', 'reuse'].includes(result.status) ? 0 : 2;
  } catch (error) {
    const safe = error instanceof SafeError
      ? error
      : new SafeError('unexpected-error', 'Unable to validate Firebase client config.');
    process.stdout.write(`${JSON.stringify({
      status: 'error',
      issues: [issue(safe.code, 'input', safe.message)],
    }, null, 2)}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  decodeXmlText,
  extractPlistString,
  hasAdminCredentialShape,
  inspectFiles,
  isWithinRoot,
  parseArgs,
  parseAndroidClientIdentities,
  parsePlistStrings,
  validateAndroidConfig,
  validateConfig,
  validateIosConfig,
  main,
};
