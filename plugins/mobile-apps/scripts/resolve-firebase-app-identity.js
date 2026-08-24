#!/usr/bin/env node

'use strict';

// Resolves the app identity needed when registering Firebase Android/iOS apps from
// already-evaluated Expo public config. This helper deliberately does not invoke Expo:
// callers run `npx expo config --type public --json` themselves and pass that JSON on
// stdin (preferred) or through a project-local file.
//
// Usage:
//   npx expo config --type public --json | node scripts/resolve-firebase-app-identity.js
//   node scripts/resolve-firebase-app-identity.js --project-root . --input expo-public.json
//   node scripts/resolve-firebase-app-identity.js --input firebase/.android-apps.mcp.yaml \
//     --match-platform android --identifier com.contoso.app
//   node scripts/resolve-firebase-app-identity.js --input firebase/.android-apps.mcp.yaml \
//     --match-platform android --identifier com.contoso.app \
//     --selected-app-id 1:123:android:abc
//
// Exit codes:
//   0 - identities are ready, matching completed, or safe duplicate selection is required
//   1 - invocation, path-safety, read, or input parsing error
//   2 - config identity is invalid, or Firebase app records are ambiguous/conflicting

const fs = require('node:fs');
const path = require('node:path');
const { firstUnsafeMcpValue } = require('./lib/mcp-result-safety');

const MAX_CONFIG_BYTES = 1024 * 1024;
const PLACEHOLDER_IDENTIFIER = 'com.contoso.powerappsapp';
const PLATFORM_ORDER = ['ios', 'android', 'web'];
const ANDROID_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const IOS_BUNDLE_IDENTIFIER_RE = /^[A-Za-z0-9]+(?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9]+(?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

class SafeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv, cwd = process.cwd()) {
  const parsed = {
    projectRoot: cwd,
    input: null,
    matchPlatform: null,
    identifier: null,
    selectedAppId: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === '--project-root'
      || arg === '--input'
      || arg === '--match-platform'
      || arg === '--identifier'
      || arg === '--selected-app-id'
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new SafeError('missing-argument-value', `${arg} requires a value.`);
      }
      if (arg === '--project-root') parsed.projectRoot = value;
      else if (arg === '--input') parsed.input = value;
      else if (arg === '--match-platform') parsed.matchPlatform = value.toLowerCase();
      else if (arg === '--identifier') parsed.identifier = value;
      else parsed.selectedAppId = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new SafeError('unknown-argument', `Unknown argument: ${arg}`);
    }
  }
  if ((parsed.matchPlatform && !parsed.identifier) || (!parsed.matchPlatform && parsed.identifier)) {
    throw new SafeError(
      'incomplete-match-arguments',
      '--match-platform and --identifier must be provided together.',
    );
  }
  if (parsed.selectedAppId && !parsed.matchPlatform) {
    throw new SafeError(
      'selection-without-match',
      '--selected-app-id requires --match-platform and --identifier.',
    );
  }
  if (parsed.matchPlatform && !['android', 'ios'].includes(parsed.matchPlatform)) {
    throw new SafeError('unsupported-match-platform', '--match-platform must be android or ios.');
  }
  return parsed;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
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

function resolveInputPath(projectRoot, inputArg) {
  const requested = path.resolve(projectRoot, inputArg);
  if (!isWithinRoot(requested, projectRoot)) {
    throw new SafeError('input-outside-project-root', 'Input file must be inside project root.');
  }

  let stat;
  try {
    stat = fs.lstatSync(requested);
  } catch {
    throw new SafeError('input-not-found', 'Input file does not exist.');
  }
  // Reject the named symlink as well as parent-directory symlink escapes. Reading only
  // regular, real paths prevents a project-local filename from redirecting this helper
  // to credentials or config elsewhere on the machine.
  if (stat.isSymbolicLink()) {
    throw new SafeError('input-symbolic-link', 'Input file must not be a symbolic link.');
  }
  if (!stat.isFile()) {
    throw new SafeError('input-not-file', 'Input path must be a regular file.');
  }

  const realInput = fs.realpathSync(requested);
  if (!isWithinRoot(realInput, projectRoot)) {
    throw new SafeError('input-outside-project-root', 'Input file must be inside project root.');
  }
  return realInput;
}

function validateIdentifier(value, kind) {
  if (typeof value !== 'string' || value.trim() === '') return 'missing';
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === PLACEHOLDER_IDENTIFIER) return 'placeholder';
  if (trimmed.length > 255) return 'invalid';
  const pattern = kind === 'android' ? ANDROID_PACKAGE_RE : IOS_BUNDLE_IDENTIFIER_RE;
  return pattern.test(trimmed) ? 'valid' : 'invalid';
}

function issue(code, field, message) {
  return { code, field, message };
}

function resolveFirebaseAppIdentity(input) {
  const issues = [];
  const config = input && typeof input === 'object' && !Array.isArray(input) && input.expo
    ? input.expo
    : input;

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {
      status: 'invalid',
      identity: { displayName: null, androidPackage: null, iosBundleIdentifier: null },
      targetPlatforms: [],
      platforms: {
        ios: { selected: false, identifier: null, state: 'not-selected' },
        android: { selected: false, identifier: null, state: 'not-selected' },
        web: { selected: false },
      },
      issues: [issue('config-not-object', 'config', 'Expo public config must be a JSON object.')],
    };
  }

  const displayName = typeof config.name === 'string' ? config.name.trim() : '';
  if (!displayName) {
    issues.push(issue('display-name-missing', 'name', 'Expo config name must be a non-empty string.'));
  }

  const rawPlatforms = config.platforms;
  const selectedSet = new Set();
  if (!Array.isArray(rawPlatforms) || rawPlatforms.length === 0) {
    issues.push(issue('platforms-missing', 'platforms', 'Expo config platforms must be a non-empty array.'));
  } else {
    for (const platform of rawPlatforms) {
      if (typeof platform !== 'string' || !PLATFORM_ORDER.includes(platform)) {
        issues.push(issue('platform-invalid', 'platforms', 'Expo config platforms may contain only ios, android, or web.'));
      } else if (selectedSet.has(platform)) {
        issues.push(issue('platform-duplicate', 'platforms', `Expo config platforms contains duplicate ${platform}.`));
      } else {
        selectedSet.add(platform);
      }
    }
  }
  const targetPlatforms = PLATFORM_ORDER.filter((platform) => selectedSet.has(platform));

  const androidPackage = typeof config.android?.package === 'string'
    ? config.android.package.trim()
    : null;
  const iosBundleIdentifier = typeof config.ios?.bundleIdentifier === 'string'
    ? config.ios.bundleIdentifier.trim()
    : null;

  function platformIdentity(platform, identifier, field) {
    const selected = selectedSet.has(platform);
    const state = selected ? validateIdentifier(identifier, platform) : 'not-selected';
    if (selected && state !== 'valid') {
      const messages = {
        missing: `Selected ${platform} target is missing ${field}.`,
        placeholder: `Selected ${platform} target still uses the template placeholder ${PLACEHOLDER_IDENTIFIER}.`,
        invalid: `Selected ${platform} target has an invalid ${field}.`,
      };
      issues.push(issue(`${platform}-identifier-${state}`, field, messages[state]));
    }
    return {
      selected,
      identifier,
      state,
      placeholder: typeof identifier === 'string'
        && identifier.toLowerCase() === PLACEHOLDER_IDENTIFIER,
    };
  }

  const platforms = {
    ios: platformIdentity('ios', iosBundleIdentifier, 'ios.bundleIdentifier'),
    android: platformIdentity('android', androidPackage, 'android.package'),
    web: { selected: selectedSet.has('web') },
  };

  return {
    status: issues.length === 0 ? 'ready' : 'invalid',
    identity: {
      displayName: displayName || null,
      androidPackage,
      iosBundleIdentifier,
    },
    targetPlatforms,
    platforms,
    issues,
  };
}

function unwrapFirebaseAppsList(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') {
    throw new SafeError('apps-list-invalid', 'Firebase apps:list JSON must be an object or array.');
  }
  const unsafe = firstUnsafeMcpValue(input, { context: 'Firebase apps:list' });
  if (unsafe) throw new SafeError(unsafe.code, unsafe.message);
  if (typeof input.status === 'string' && input.status !== 'success') {
    throw new SafeError('apps-list-failed', 'Firebase apps:list did not return success status.');
  }

  // Firebase CLI's JSON command wrapper returns `{status:"success",result:[...]}`.
  // Direct arrays are also accepted for fixtures/piped transformations. Some released
  // command wrappers have retained an `apps` property around that array, so unwrap only
  // these known data envelopes rather than recursively trusting arbitrary JSON.
  if ('result' in input) return unwrapFirebaseAppsList(input.result);
  if (Array.isArray(input.apps)) return input.apps;
  if (input.apps && typeof input.apps === 'object' && !Array.isArray(input.apps)) {
    const flattened = [];
    for (const [bucket, value] of Object.entries(input.apps)) {
      if (!Array.isArray(value)) {
        throw new SafeError(
          'apps-list-shape-unsupported',
          `Firebase apps:list bucket ${bucket} must be an array.`,
        );
      }
      flattened.push(...value);
    }
    return flattened;
  }
  throw new SafeError('apps-list-shape-unsupported', 'Firebase apps:list JSON has no app array.');
}

function summarizeFirebaseApp(record) {
  const summary = {
    appId: typeof record.appId === 'string' ? record.appId : null,
    displayName: typeof record.displayName === 'string' ? record.displayName : null,
    platform: typeof record.platform === 'string' ? record.platform.toUpperCase() : null,
    packageName: typeof record.packageName === 'string' ? record.packageName : null,
    bundleId: typeof record.bundleId === 'string' ? record.bundleId : null,
  };
  if (Object.values(summary).every((value) => value === null)) {
    throw new SafeError(
      'apps-list-record-unsupported',
      'Firebase apps:list record has no supported identity fields.',
    );
  }
  return summary;
}

function matchFirebaseApp(input, platform, identifier, selectedAppId = null) {
  const expectedPlatform = platform.toUpperCase();
  const identityField = platform === 'android' ? 'packageName' : 'bundleId';
  if (validateIdentifier(identifier, platform) !== 'valid') {
    throw new SafeError('identifier-invalid', `Invalid ${platform} identifier.`);
  }

  const records = unwrapFirebaseAppsList(input);
  const unsafe = firstUnsafeMcpValue(records, { context: 'Firebase apps:list' });
  if (unsafe) throw new SafeError(unsafe.code, unsafe.message);
  const apps = records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new SafeError('apps-list-record-invalid', 'Firebase apps:list contains a non-object record.');
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        throw new SafeError(
          'apps-list-record-nested',
          'Firebase apps:list records must stay flat scalar objects.',
        );
      }
    }
    return summarizeFirebaseApp(record);
  });

  const conflicts = [];
  const byAppId = new Map();
  for (const app of apps) {
    if (!app.appId) continue;
    const previous = byAppId.get(app.appId);
    const signature = JSON.stringify([app.platform, app.packageName, app.bundleId]);
    if (previous && previous !== signature) {
      conflicts.push({
        code: 'app-id-conflict',
        appId: app.appId,
        message: 'One Firebase app ID has conflicting platform identity records.',
      });
    } else {
      byAppId.set(app.appId, signature);
    }
  }

  const exactIdentityRecords = apps.filter((app) => app[identityField] === identifier);
  for (const app of exactIdentityRecords) {
    if (!app.platform || app.platform !== expectedPlatform) {
      conflicts.push({
        code: 'platform-conflict',
        appId: app.appId,
        message: `Exact ${identityField} appears without the expected ${expectedPlatform} platform.`,
      });
    }
    if (!app.appId) {
      conflicts.push({
        code: 'matching-app-id-missing',
        appId: null,
        message: `Exact ${identityField} record is missing appId.`,
      });
    }
  }

  const exactMatches = exactIdentityRecords.filter(
    (app) => app.platform === expectedPlatform && app.appId,
  );
  const uniqueMatches = [...new Map(exactMatches.map((app) => [app.appId, app])).values()];
  if (conflicts.length > 0) {
    return {
      status: 'ambiguous',
      platform,
      identifier,
      identityField,
      candidates: uniqueMatches,
      conflicts,
    };
  }
  if (selectedAppId) {
    const selected = uniqueMatches.find((app) => app.appId === selectedAppId);
    if (!selected) {
      const selectedRecords = apps.filter((app) => app.appId === selectedAppId);
      const selectionCode = selectedRecords.length === 0
        ? 'selected-app-id-not-found'
        : 'selected-app-identity-mismatch';
      return {
        status: 'ambiguous',
        platform,
        identifier,
        identityField,
        candidates: uniqueMatches,
        conflicts: [{
          code: selectionCode,
          appId: selectedAppId,
          message: selectedRecords.length === 0
            ? 'Selected Firebase app ID was not present in the latest app listing.'
            : `Selected Firebase app ID does not have the exact requested ${expectedPlatform} identity.`,
        }],
      };
    }
    return {
      status: 'match',
      platform,
      identifier,
      identityField,
      app: selected,
      selectedExplicitly: true,
      conflicts: [],
    };
  }
  if (uniqueMatches.length > 1) {
    return {
      status: 'selection-required',
      platform,
      identifier,
      identityField,
      candidates: uniqueMatches,
      conflicts: [],
    };
  }
  if (uniqueMatches.length === 1) {
    return {
      status: 'match',
      platform,
      identifier,
      identityField,
      app: uniqueMatches[0],
      selectedExplicitly: false,
      conflicts: [],
    };
  }
  return {
    status: 'no-match',
    platform,
    identifier,
    identityField,
    app: null,
    conflicts: [],
  };
}

async function readStdin(stream) {
  let input = '';
  for await (const chunk of stream) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_CONFIG_BYTES) {
      throw new SafeError('input-too-large', `Expo public config exceeds ${MAX_CONFIG_BYTES} bytes.`);
    }
  }
  if (input.trim() === '') {
    throw new SafeError('input-empty', 'Expected Expo public-config JSON on stdin.');
  }
  return input;
}

function parseYamlScalar(rawValue) {
  const value = rawValue.trim();
  if (value === '' || value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new SafeError('invalid-mcp-yaml', 'Firebase MCP app output has an invalid quoted value.');
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) {
      throw new SafeError('invalid-mcp-yaml', 'Firebase MCP app output has an invalid quoted value.');
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/[\[\]{}|>&*!]/.test(value)) {
    throw new SafeError(
      'unsupported-mcp-yaml',
      'Firebase MCP app output contains an unsupported YAML value.',
    );
  }
  return value;
}

function parseFirebaseMcpAppsYaml(raw) {
  const trimmed = raw.trim();
  if (trimmed === '[]') return [];

  // `firebase_list_apps` serializes its array with js-yaml as a flat sequence:
  //   - name: projects/example/androidApps/1:123:android:abc
  //     appId: 1:123:android:abc
  //     platform: ANDROID
  //     packageName: com.contoso.app
  // Native app identity fields are scalar, so reject nested collections, tags,
  // anchors, and block scalars rather than accepting general-purpose YAML.
  const records = [];
  let current = null;
  for (const originalLine of raw.split(/\r?\n/)) {
    if (originalLine.trim() === '') continue;
    if (originalLine.includes('\t')) {
      throw new SafeError('invalid-mcp-yaml', 'Firebase MCP app output must not contain tabs.');
    }
    const recordStart = /^- ([A-Za-z][A-Za-z0-9_]*):(?: (.*))?$/.exec(originalLine);
    const property = /^  ([A-Za-z][A-Za-z0-9_]*):(?: (.*))?$/.exec(originalLine);
    if (recordStart) {
      current = {};
      records.push(current);
      current[recordStart[1]] = parseYamlScalar(recordStart[2] || '');
    } else if (property && current) {
      if (Object.prototype.hasOwnProperty.call(current, property[1])) {
        throw new SafeError('duplicate-mcp-yaml-field', 'Firebase MCP app output repeats a field.');
      }
      current[property[1]] = parseYamlScalar(property[2] || '');
    } else {
      throw new SafeError(
        'unsupported-mcp-yaml',
        'Firebase MCP app output is not the expected flat app-list shape.',
      );
    }
  }
  if (records.length === 0) {
    throw new SafeError('invalid-mcp-yaml', 'Firebase MCP app output contains no app records.');
  }
  return records;
}

function parseInput(raw, allowMcpAppsYaml) {
  try {
    return JSON.parse(raw);
  } catch {
    if (allowMcpAppsYaml) return parseFirebaseMcpAppsYaml(raw);
    throw new SafeError('invalid-json', 'Input is not valid JSON.');
  }
}

function usage() {
  return [
    'Usage: node resolve-firebase-app-identity.js [--project-root <path>] [--input <project-local-path>]',
    '       node resolve-firebase-app-identity.js --match-platform <android|ios> --identifier <id>',
    '         [--selected-app-id <firebase-app-id>]',
    '         [--project-root <path>] [--input <project-local-path>]',
    '',
    'Without match arguments, input is evaluated Expo public-config JSON.',
    'With match arguments, input is Firebase app-list JSON or the raw firebase_list_apps MCP YAML text.',
    'Safe duplicate exact matches require a second call with --selected-app-id.',
    'Without --input, input is read from stdin.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), stdin = process.stdin, cwd = process.cwd()) {
  try {
    const args = parseArgs(argv, cwd);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }

    const projectRoot = resolveProjectRoot(args.projectRoot);
    let raw;
    let source;
    if (args.input) {
      const inputPath = resolveInputPath(projectRoot, args.input);
      const stat = fs.statSync(inputPath);
      if (stat.size > MAX_CONFIG_BYTES) {
        throw new SafeError('input-too-large', `Expo public config exceeds ${MAX_CONFIG_BYTES} bytes.`);
      }
      raw = fs.readFileSync(inputPath, 'utf8');
      source = {
        kind: 'file',
        path: path.relative(projectRoot, inputPath).split(path.sep).join('/'),
      };
    } else {
      raw = await readStdin(stdin);
      source = { kind: 'stdin' };
    }

    const parsedInput = parseInput(raw, Boolean(args.matchPlatform));
    const result = args.matchPlatform
      ? matchFirebaseApp(
        parsedInput,
        args.matchPlatform,
        args.identifier,
        args.selectedAppId,
      )
      : resolveFirebaseAppIdentity(parsedInput);
    result.source = source;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return ['ready', 'match', 'no-match', 'selection-required'].includes(result.status) ? 0 : 2;
  } catch (error) {
    const safe = error instanceof SafeError
      ? error
      : new SafeError('unexpected-error', 'Unable to resolve Firebase app identity.');
    process.stdout.write(`${JSON.stringify({
      status: 'error',
      issues: [issue(safe.code, 'input', safe.message)],
    }, null, 2)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  isWithinRoot,
  parseArgs,
  parseFirebaseMcpAppsYaml,
  parseInput,
  matchFirebaseApp,
  resolveFirebaseAppIdentity,
  resolveInputPath,
  unwrapFirebaseAppsList,
  validateIdentifier,
  main,
};
